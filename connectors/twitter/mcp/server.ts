#!/usr/bin/env bun
/**
 * Twitter MCP Server — reads Following timeline via Twitter's internal GraphQL API.
 *
 * Auth: cookie-based (auth_token + ct0 from browser, stored in macOS Keychain).
 * Endpoint: HomeLatestTimeline (the "Following" tab — chronological, no recommendations).
 * Rate limit: max once per hour to avoid scraping detection.
 * Zero external dependencies — uses native fetch().
 *
 * Stores per-account tweet files in vault at private/context/twitter/<handle>.md
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import {
  resolveVaultPath,
  ensureVaultDir,
  readVaultFile,
  readSyncState,
  writeSyncState,
  formatISO,
  getConfigDir,
} from "../../_shared/vault";
import { appendToInbox } from "../../shared/inbox";
import { getSecretUngated } from "../../_shared/keychain-gate";

// --- Constants ---

const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const ACCOUNTS_PATH = join(getConfigDir(), "twitter-accounts.json");
const QUERY_ID_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const TIMELINE_COUNT = 80;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TIMELINE_FEATURES: Record<string, boolean> = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  longform_notetweets_rich_text_read_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  interactive_text_enabled: true,
  responsive_web_text_conversations_enabled: false,
  rweb_video_timestamps_enabled: true,
};

// --- Types ---

interface AccountsConfig {
  accounts: { handle: string; category?: string }[];
  myHandle?: string;
}

interface TweetMetrics {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  views: number;
}

interface Tweet {
  id: string;
  text: string;
  date: string;
  url: string;
  authorHandle: string;
  authorName: string;
  isRetweet: boolean;
  retweetedFrom?: string;
  metrics: TweetMetrics;
}

interface Credentials {
  authToken: string;
  ct0: string;
}

// --- Credentials ---

function getCredentials(): Credentials | null {
  const authToken = getSecretUngated("twitter", "TWITTER_AUTH_TOKEN", "collect");
  const ct0 = getSecretUngated("twitter", "TWITTER_CT0", "collect");
  if (!authToken || !ct0) return null;
  return { authToken, ct0 };
}

// --- QueryId resolution ---

// Known HomeLatestTimeline queryIds (the "Following" tab — chronological, no recommendations).
// Twitter rotates these but many remain valid for months.
// If all fail, the connector attempts to discover from x.com JS bundles.
const TIMELINE_OPERATION = "HomeLatestTimeline";
const KNOWN_QUERY_IDS = [
  "zhX91JE87mWvfprhYE97xA",
  "U0cdisy7QFIoTfu3-Okw0A",
];

const USER_TWEETS_OPERATION = "UserTweets";
const KNOWN_USER_TWEETS_QUERY_IDS = [
  "E3opETHurmVJflFsUBVuUQ",
  "CdG2Vuc1v6F5JyEngGpxVw",
  "QWF3SzpHmykQHsQMixG0cg",
];

const USER_BY_SCREEN_NAME_OPERATION = "UserByScreenName";
const KNOWN_USER_BY_SCREEN_NAME_QUERY_IDS = [
  "qW5u-DAen47o2oBGJtGv1g",
  "G3KGOASz96M-Qu0nwmGXNg",
  "xc8f1g7BYqr6VTzTbvNlGw",
];

async function resolveQueryId(creds: Credentials): Promise<string> {
  // Check cache first
  const state = readSyncState("private", "context", "twitter");
  if (state?.queryId && state?.queryIdVerifiedAt) {
    const age = Date.now() - new Date(state.queryIdVerifiedAt).getTime();
    if (age < QUERY_ID_CACHE_TTL_MS) return state.queryId;
  }

  // Try known queryIds with a lightweight probe
  const variables = encodeURIComponent(JSON.stringify({ count: 1, includePromotedContent: false }));
  const features = encodeURIComponent(JSON.stringify(TIMELINE_FEATURES));

  for (const qid of KNOWN_QUERY_IDS) {
    try {
      const res = await fetch(
        `https://x.com/i/api/graphql/${qid}/${TIMELINE_OPERATION}?variables=${variables}&features=${features}`,
        { method: "GET", headers: buildHeaders(creds) }
      );
      if (res.ok) {
        writeSyncState(
          { ...state, queryId: qid, queryIdVerifiedAt: new Date().toISOString() },
          "private", "context", "twitter"
        );
        return qid;
      }
    } catch {
      continue;
    }
  }

  // Fallback: discover from x.com JS bundles
  return await discoverQueryIdFromBundle(state);
}

async function discoverQueryIdFromBundle(state: Record<string, any> | null): Promise<string> {
  const homeRes = await fetch("https://x.com", {
    headers: { "user-agent": USER_AGENT },
  });
  if (!homeRes.ok) throw new Error(`Failed to fetch x.com: ${homeRes.status}`);
  const html = await homeRes.text();

  const bundleUrls: string[] = [];
  for (const m of html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s]+\.js/g)) {
    bundleUrls.push(m[0]);
  }

  for (const url of bundleUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const js = await res.text();

      const match = js.match(new RegExp(`queryId:"([a-zA-Z0-9_-]+)",operationName:"${TIMELINE_OPERATION}"`));
      if (match?.[1]) {
        writeSyncState(
          { ...state, queryId: match[1], queryIdVerifiedAt: new Date().toISOString() },
          "private", "context", "twitter"
        );
        return match[1];
      }
    } catch {
      continue;
    }
  }

  throw new Error("Could not resolve HomeTimeline queryId. All known IDs failed and bundle discovery found nothing.");
}

// --- Twitter API ---

function buildHeaders(creds: Credentials): Record<string, string> {
  return {
    authorization: `Bearer ${BEARER_TOKEN}`,
    "x-csrf-token": creds.ct0,
    cookie: `auth_token=${creds.authToken}; ct0=${creds.ct0}`,
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "user-agent": USER_AGENT,
  };
}

async function fetchHomeTimeline(creds: Credentials, queryId: string): Promise<Tweet[]> {
  const variables = JSON.stringify({
    count: TIMELINE_COUNT,
    includePromotedContent: false,
    latestControlAvailable: true,
    requestContext: "launch",
  });

  const features = JSON.stringify(TIMELINE_FEATURES);

  const url = `https://x.com/i/api/graphql/${queryId}/${TIMELINE_OPERATION}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(creds),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Twitter cookies expired or invalid. Update auth_token and ct0 in Keychain.");
  }

  if (res.status === 429) {
    throw new Error("Twitter rate limit hit. Try again later.");
  }

  if (res.status === 422) {
    throw new Error("STALE_QUERY_ID");
  }

  if (!res.ok) {
    throw new Error(`Twitter API error ${res.status}`);
  }

  const json = await res.json();
  return parseTimelineResponse(json);
}

// --- Response parsing ---

function parseTimelineResponse(json: any): Tweet[] {
  const tweets: Tweet[] = [];

  const instructions =
    json?.data?.home?.home_timeline_urt?.instructions ??
    json?.data?.home_timeline_urt?.instructions ??
    [];

  for (const instruction of instructions) {
    const entries = instruction?.entries ?? [];
    for (const entry of entries) {
      const tweet = parseTweetEntry(entry);
      if (tweet) tweets.push(tweet);
    }
  }

  return tweets;
}

function extractMetrics(result: any, legacy: any): TweetMetrics {
  return {
    likes: legacy?.favorite_count ?? 0,
    retweets: legacy?.retweet_count ?? 0,
    replies: legacy?.reply_count ?? 0,
    quotes: legacy?.quote_count ?? 0,
    bookmarks: legacy?.bookmark_count ?? 0,
    views: parseInt(result?.views?.count ?? "0", 10) || 0,
  };
}

function parseTweetEntry(entry: any): Tweet | null {
  const content = entry?.content;
  if (!content || content.entryType !== "TimelineTimelineItem") return null;

  const itemContent = content?.itemContent;
  if (!itemContent || itemContent.itemType !== "TimelineTweet") return null;

  // Skip promoted tweets
  if (itemContent.promotedMetadata) return null;

  let result = itemContent?.tweet_results?.result;
  if (!result) return null;

  // Handle TweetWithVisibilityResults wrapper
  if (result.__typename === "TweetWithVisibilityResults") {
    result = result.tweet;
  }

  if (!result || result.__typename !== "Tweet") return null;

  const legacy = result.legacy;
  const userLegacy = result.core?.user_results?.result?.legacy;
  if (!legacy || !userLegacy) return null;

  const authorHandle = userLegacy.screen_name?.toLowerCase() ?? "";
  const authorName = userLegacy.name ?? authorHandle;
  const tweetId = legacy.id_str ?? entry.sortIndex ?? "";
  // Long-form tweets (Notes) have full text in note_tweet; legacy.full_text is truncated
  const text = result.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? "";
  const createdAt = legacy.created_at
    ? new Date(legacy.created_at).toISOString().slice(0, 19)
    : formatISO();

  // Check if it's a retweet
  const rtResult = legacy.retweeted_status_result?.result;
  if (rtResult) {
    const rtLegacy = rtResult.__typename === "TweetWithVisibilityResults"
      ? rtResult.tweet?.legacy
      : rtResult.legacy;
    const rtUser = rtResult.__typename === "TweetWithVisibilityResults"
      ? rtResult.tweet?.core?.user_results?.result?.legacy
      : rtResult.core?.user_results?.result?.legacy;

    if (rtLegacy && rtUser) {
      const rtTweet = rtResult.__typename === "TweetWithVisibilityResults" ? rtResult.tweet : rtResult;
      const rtHandle = rtUser.screen_name?.toLowerCase() ?? "";
      const rtId = rtLegacy.id_str ?? tweetId;
      return {
        id: rtId,
        text: rtTweet?.note_tweet?.note_tweet_results?.result?.text ?? rtLegacy.full_text ?? text,
        date: rtLegacy.created_at
          ? new Date(rtLegacy.created_at).toISOString().slice(0, 19)
          : createdAt,
        url: `https://x.com/${rtHandle}/status/${rtId}`,
        authorHandle: rtHandle,
        authorName: rtUser.name ?? rtHandle,
        isRetweet: true,
        retweetedFrom: authorHandle,
        metrics: extractMetrics(rtResult.__typename === "TweetWithVisibilityResults" ? rtResult.tweet : rtResult, rtLegacy),
      };
    }
  }

  return {
    id: tweetId,
    text,
    date: createdAt,
    url: `https://x.com/${authorHandle}/status/${tweetId}`,
    authorHandle,
    authorName,
    isRetweet: false,
    metrics: extractMetrics(result, legacy),
  };
}

// --- Account management ---

function loadAccounts(): AccountsConfig {
  if (!existsSync(ACCOUNTS_PATH)) return { accounts: [] };
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf-8"));
    return { accounts: raw.accounts ?? [], myHandle: raw.myHandle };
  } catch {
    return { accounts: [] };
  }
}

function resolveMyHandle(config: AccountsConfig): string | undefined {
  if (config.myHandle) return config.myHandle.toLowerCase();
  // Fallback: read from who-am-i.md
  const whoami = readVaultFile("private", "context", "who-am-i.md");
  if (!whoami) return undefined;
  const match = whoami.match(/Twitter:\s*@?(\w+)/i);
  return match?.[1]?.toLowerCase();
}

function saveAccounts(config: AccountsConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(config, null, 2));
}

// --- Vault storage ---

function loadExistingTweets(handle: string): Set<string> {
  const content = readVaultFile("private", "context", "twitter", `${handle}.md`);
  if (!content) return new Set();
  const ids = new Set<string>();
  for (const m of content.matchAll(/<!-- tweet:(\S+) -->/g)) ids.add(m[1]);
  return ids;
}

function appendTweetsToFile(handle: string, tweets: Tweet[], category?: string): number {
  ensureVaultDir("private", "context", "twitter");
  const filePath = resolveVaultPath("private", "context", "twitter", `${handle}.md`);
  const existingIds = loadExistingTweets(handle);

  const newTweets = tweets.filter((t) => !existingIds.has(t.id));
  if (newTweets.length === 0) return 0;

  let content: string;
  if (!existsSync(filePath)) {
    content = `---
handle: ${handle}
type: twitter-account
${category ? `category: ${category}\n` : ""}last_updated: ${formatISO()}
---

# @${handle}

`;
  } else {
    content = readFileSync(filePath, "utf-8");
    content = content.replace(/last_updated: .+/, `last_updated: ${formatISO()}`);
  }

  const sorted = newTweets.sort((a, b) => b.date.localeCompare(a.date));
  const tweetBlock = sorted
    .map((t) => {
      const meta = t.isRetweet ? ` (RT by @${t.retweetedFrom})` : "";
      const m = t.metrics;
      const metricsLine = `> views: ${m.views} | likes: ${m.likes} | rt: ${m.retweets} | replies: ${m.replies} | quotes: ${m.quotes} | bookmarks: ${m.bookmarks}`;
      return `<!-- tweet:${t.id} -->\n### ${t.date}${meta}\n\n${t.text}\n\n${metricsLine}\n\n[Link](${t.url})\n`;
    })
    .join("\n---\n\n");

  const headerEnd = content.indexOf("\n# @");
  if (headerEnd !== -1) {
    const afterHeader = content.indexOf("\n", headerEnd + 1);
    const before = content.slice(0, afterHeader + 1);
    const after = content.slice(afterHeader + 1);
    content = before + "\n" + tweetBlock + "\n---\n\n" + after;
  } else {
    content += tweetBlock;
  }

  writeFileSync(filePath, content);
  return newTweets.length;
}

// --- My posts storage ---

function loadMyPostIds(): Set<string> {
  const content = readVaultFile("private", "context", "twitter", "my-posts.md");
  if (!content) return new Set();
  const ids = new Set<string>();
  for (const m of content.matchAll(/<!-- tweet:(\S+) -->/g)) ids.add(m[1]);
  return ids;
}

function appendMyPosts(tweets: Tweet[], myHandle: string): number {
  ensureVaultDir("private", "context", "twitter");
  const filePath = resolveVaultPath("private", "context", "twitter", "my-posts.md");
  const existingIds = loadMyPostIds();

  const newTweets = tweets.filter((t) => !existingIds.has(t.id));
  if (newTweets.length === 0) return 0;

  let content: string;
  if (!existsSync(filePath)) {
    content = `---
handle: ${myHandle}
type: my-twitter-posts
last_updated: ${formatISO()}
---

# My Posts (@${myHandle})

`;
  } else {
    content = readFileSync(filePath, "utf-8");
    content = content.replace(/last_updated: .+/, `last_updated: ${formatISO()}`);
  }

  const sorted = newTweets.sort((a, b) => b.date.localeCompare(a.date));
  const tweetBlock = sorted
    .map((t) => {
      const m = t.metrics;
      const metricsLine = `> views: ${m.views} | likes: ${m.likes} | rt: ${m.retweets} | replies: ${m.replies} | quotes: ${m.quotes} | bookmarks: ${m.bookmarks}`;
      return `<!-- tweet:${t.id} -->\n### ${t.date}\n\n${t.text}\n\n${metricsLine}\n\n[Link](${t.url})\n`;
    })
    .join("\n---\n\n");

  const headerEnd = content.indexOf("\n# My Posts");
  if (headerEnd !== -1) {
    const afterHeader = content.indexOf("\n", headerEnd + 1);
    const before = content.slice(0, afterHeader + 1);
    const after = content.slice(afterHeader + 1);
    content = before + "\n" + tweetBlock + "\n---\n\n" + after;
  } else {
    content += tweetBlock;
  }

  writeFileSync(filePath, content);
  return newTweets.length;
}

// --- Rate limiting ---

function checkSyncCooldown(): { allowed: boolean; waitMinutes: number } {
  const state = readSyncState("private", "context", "twitter");
  if (!state?.lastSync) return { allowed: true, waitMinutes: 0 };

  const elapsed = Date.now() - new Date(state.lastSync).getTime();
  if (elapsed >= MIN_SYNC_INTERVAL_MS) return { allowed: true, waitMinutes: 0 };

  const remaining = MIN_SYNC_INTERVAL_MS - elapsed;
  return { allowed: false, waitMinutes: Math.ceil(remaining / 60_000) };
}

// --- User profile fetching ---

async function resolveOperationQueryId(
  creds: Credentials,
  operation: string,
  knownIds: string[],
  cacheKey: string,
): Promise<string> {
  const state = readSyncState("private", "context", "twitter");
  if (state?.[cacheKey] && state?.[`${cacheKey}VerifiedAt`]) {
    const age = Date.now() - new Date(state[`${cacheKey}VerifiedAt`]).getTime();
    if (age < QUERY_ID_CACHE_TTL_MS) return state[cacheKey];
  }

  // Try known queryIds with a lightweight probe
  const testVars = operation === USER_BY_SCREEN_NAME_OPERATION
    ? { screen_name: "x" }
    : { userId: "1", count: 1, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: true, withVoice: true, withV2Timeline: true };
  const variables = encodeURIComponent(JSON.stringify(testVars));
  const features = encodeURIComponent(JSON.stringify(TIMELINE_FEATURES));

  for (const qid of knownIds) {
    try {
      const res = await fetch(
        `https://x.com/i/api/graphql/${qid}/${operation}?variables=${variables}&features=${features}`,
        { method: "GET", headers: buildHeaders(creds) }
      );
      if (res.ok || res.status === 200) {
        const updated = { ...state, [cacheKey]: qid, [`${cacheKey}VerifiedAt`]: new Date().toISOString() };
        writeSyncState(updated, "private", "context", "twitter");
        return qid;
      }
    } catch {
      continue;
    }
  }

  // Fallback: discover from bundles
  const homeRes = await fetch("https://x.com", { headers: { "user-agent": USER_AGENT } });
  if (!homeRes.ok) throw new Error(`Failed to fetch x.com: ${homeRes.status}`);
  const html = await homeRes.text();

  for (const m of html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s]+\.js/g)) {
    try {
      const res = await fetch(m[0]);
      if (!res.ok) continue;
      const js = await res.text();
      const match = js.match(new RegExp(`queryId:"([a-zA-Z0-9_-]+)",operationName:"${operation}"`));
      if (match?.[1]) {
        const updated = { ...state, [cacheKey]: match[1], [`${cacheKey}VerifiedAt`]: new Date().toISOString() };
        writeSyncState(updated, "private", "context", "twitter");
        return match[1];
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Could not resolve ${operation} queryId.`);
}

async function fetchUserId(creds: Credentials, handle: string): Promise<string> {
  const queryId = await resolveOperationQueryId(
    creds, USER_BY_SCREEN_NAME_OPERATION,
    KNOWN_USER_BY_SCREEN_NAME_QUERY_IDS, "userByScreenNameQueryId"
  );

  const variables = JSON.stringify({
    screen_name: handle,
    withSafetyModeUserFields: true,
  });
  const features = JSON.stringify({
    ...TIMELINE_FEATURES,
    hidden_profile_subscriptions_enabled: true,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
  });

  const url = `https://x.com/i/api/graphql/${queryId}/${USER_BY_SCREEN_NAME_OPERATION}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const res = await fetch(url, { method: "GET", headers: buildHeaders(creds) });

  if (!res.ok) throw new Error(`Failed to fetch user ID for @${handle}: ${res.status}`);
  const json = await res.json();
  const userId = json?.data?.user?.result?.rest_id;
  if (!userId) throw new Error(`Could not resolve user ID for @${handle}`);
  return userId;
}

async function fetchUserTweets(creds: Credentials, userId: string): Promise<Tweet[]> {
  const queryId = await resolveOperationQueryId(
    creds, USER_TWEETS_OPERATION,
    KNOWN_USER_TWEETS_QUERY_IDS, "userTweetsQueryId"
  );

  const variables = JSON.stringify({
    userId,
    count: 20,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true,
  });
  const features = JSON.stringify(TIMELINE_FEATURES);

  const url = `https://x.com/i/api/graphql/${queryId}/${USER_TWEETS_OPERATION}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const res = await fetch(url, { method: "GET", headers: buildHeaders(creds) });

  if (res.status === 401 || res.status === 403) throw new Error("Twitter cookies expired or invalid.");
  if (res.status === 429) throw new Error("Twitter rate limit hit. Try again later.");
  if (!res.ok) throw new Error(`Twitter API error ${res.status}`);

  const json = await res.json();
  return parseUserTweetsResponse(json);
}

function parseUserTweetsResponse(json: any): Tweet[] {
  const tweets: Tweet[] = [];
  const instructions =
    json?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    json?.data?.user?.result?.timeline?.timeline?.instructions ??
    [];

  for (const instruction of instructions) {
    const entries = instruction?.entries ?? [];
    for (const entry of entries) {
      // UserTweets entries can be regular items or conversation modules (threads)
      const content = entry?.content;
      if (!content) continue;

      if (content.entryType === "TimelineTimelineItem") {
        const tweet = parseTweetEntry(entry);
        if (tweet) tweets.push(tweet);
      } else if (content.entryType === "TimelineTimelineModule") {
        // Thread/conversation module — parse each item
        for (const item of content.items ?? []) {
          const moduleEntry = { content: item?.item };
          if (moduleEntry.content) {
            // Wrap to match parseTweetEntry expectations
            const tweet = parseTweetEntryFromItemContent(moduleEntry.content?.itemContent);
            if (tweet) tweets.push(tweet);
          }
        }
      }
    }
  }

  return tweets;
}

function parseTweetEntryFromItemContent(itemContent: any): Tweet | null {
  if (!itemContent || itemContent.itemType !== "TimelineTweet") return null;
  if (itemContent.promotedMetadata) return null;

  let result = itemContent?.tweet_results?.result;
  if (!result) return null;

  if (result.__typename === "TweetWithVisibilityResults") result = result.tweet;
  if (!result || result.__typename !== "Tweet") return null;

  const legacy = result.legacy;
  const userLegacy = result.core?.user_results?.result?.legacy;
  if (!legacy || !userLegacy) return null;

  const authorHandle = userLegacy.screen_name?.toLowerCase() ?? "";
  const authorName = userLegacy.name ?? authorHandle;
  const tweetId = legacy.id_str ?? "";
  const text = result.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? "";
  const createdAt = legacy.created_at
    ? new Date(legacy.created_at).toISOString().slice(0, 19)
    : formatISO();

  // Skip retweets for own posts
  if (legacy.retweeted_status_result?.result) return null;

  return {
    id: tweetId,
    text,
    date: createdAt,
    url: `https://x.com/${authorHandle}/status/${tweetId}`,
    authorHandle,
    authorName,
    isRetweet: false,
    metrics: extractMetrics(result, legacy),
  };
}

function refreshMyPosts(tweets: Tweet[], myHandle: string): { added: number; updated: number } {
  ensureVaultDir("private", "context", "twitter");
  const filePath = resolveVaultPath("private", "context", "twitter", "my-posts.md");
  const existingIds = loadMyPostIds();

  // Separate new tweets and existing tweets (for metric refresh)
  const newTweets = tweets.filter((t) => !existingIds.has(t.id));
  const existingTweets = tweets.filter((t) => existingIds.has(t.id));

  let content: string;
  if (!existsSync(filePath)) {
    content = `---
handle: ${myHandle}
type: my-twitter-posts
last_updated: ${formatISO()}
---

# My Posts (@${myHandle})

`;
  } else {
    content = readFileSync(filePath, "utf-8");
    content = content.replace(/last_updated: .+/, `last_updated: ${formatISO()}`);
  }

  // Update metrics for existing tweets
  let updated = 0;
  for (const tweet of existingTweets) {
    const m = tweet.metrics;
    const newMetrics = `> views: ${m.views} | likes: ${m.likes} | rt: ${m.retweets} | replies: ${m.replies} | quotes: ${m.quotes} | bookmarks: ${m.bookmarks}`;
    const metricRegex = new RegExp(
      `(<!-- tweet:${tweet.id} -->[\\s\\S]*?)> views: \\d+[^\\n]*`
    );
    if (metricRegex.test(content)) {
      content = content.replace(metricRegex, `$1${newMetrics}`);
      updated++;
    }
  }

  // Add new tweets
  if (newTweets.length > 0) {
    const sorted = newTweets.sort((a, b) => b.date.localeCompare(a.date));
    const tweetBlock = sorted
      .map((t) => {
        const m = t.metrics;
        const metricsLine = `> views: ${m.views} | likes: ${m.likes} | rt: ${m.retweets} | replies: ${m.replies} | quotes: ${m.quotes} | bookmarks: ${m.bookmarks}`;
        return `<!-- tweet:${t.id} -->\n### ${t.date}\n\n${t.text}\n\n${metricsLine}\n\n[Link](${t.url})\n`;
      })
      .join("\n---\n\n");

    const headerEnd = content.indexOf("\n# My Posts");
    if (headerEnd !== -1) {
      const afterHeader = content.indexOf("\n", headerEnd + 1);
      const before = content.slice(0, afterHeader + 1);
      const after = content.slice(afterHeader + 1);
      content = before + "\n" + tweetBlock + "\n---\n\n" + after;
    } else {
      content += tweetBlock;
    }
  }

  writeFileSync(filePath, content);
  return { added: newTweets.length, updated };
}

async function syncMyPosts(): Promise<{ added: number; updated: number }> {
  const creds = getCredentials();
  if (!creds) throw new Error("No Twitter cookies configured");

  const config = loadAccounts();
  const myHandle = resolveMyHandle(config);
  if (!myHandle) throw new Error("No handle configured. Use set_my_handle first.");

  const userId = await fetchUserId(creds, myHandle);
  const tweets = await fetchUserTweets(creds, userId);

  // Filter to only own tweets (not retweets)
  const ownTweets = tweets.filter(
    (t) => t.authorHandle === myHandle && !t.isRetweet
  );

  return refreshMyPosts(ownTweets, myHandle);
}

// --- Sync orchestrator ---

async function syncFeed(): Promise<{ total: number; accounts: string[]; discovered: string[]; myPostsAdded: number; newTweets: Tweet[] }> {
  const creds = getCredentials();
  if (!creds) throw new Error("No Twitter cookies configured");

  const cooldown = checkSyncCooldown();
  if (!cooldown.allowed) {
    throw new Error(`Too soon — wait ${cooldown.waitMinutes} more minute(s) before syncing again to avoid scraping risk.`);
  }

  let queryId = await resolveQueryId(creds);
  let tweets: Tweet[];
  try {
    tweets = await fetchHomeTimeline(creds, queryId);
  } catch (e: any) {
    if (e.message === "STALE_QUERY_ID") {
      // Invalidate cached queryId and re-discover
      const state = readSyncState("private", "context", "twitter") ?? {};
      delete state.queryId;
      delete state.queryIdVerifiedAt;
      writeSyncState(state, "private", "context", "twitter");
      queryId = await resolveQueryId(creds);
      tweets = await fetchHomeTimeline(creds, queryId);
    } else {
      throw e;
    }
  }

  // Group by author
  const byAuthor = new Map<string, Tweet[]>();
  for (const tweet of tweets) {
    const group = byAuthor.get(tweet.authorHandle) ?? [];
    group.push(tweet);
    byAuthor.set(tweet.authorHandle, group);
  }

  let total = 0;
  const updatedAccounts: string[] = [];
  const discoveredAccounts: string[] = [];
  const allNewTweets: Tweet[] = [];
  const config = loadAccounts();

  for (const [author, authorTweets] of byAuthor) {
    // Determine which tweets are new before saving
    const existingIds = loadExistingTweets(author);
    const newForAuthor = authorTweets.filter((t) => !existingIds.has(t.id));

    const accountConfig = config.accounts.find((a) => a.handle.toLowerCase() === author);
    const added = appendTweetsToFile(author, authorTweets, accountConfig?.category);
    if (added > 0) {
      total += added;
      updatedAccounts.push(`@${author} (+${added})`);
      allNewTweets.push(...newForAuthor);

      // Track newly discovered accounts
      if (!config.accounts.some((a) => a.handle.toLowerCase() === author)) {
        discoveredAccounts.push(author);
      }
    }
  }

  // Store own tweets separately for performance analysis
  let myPostsAdded = 0;
  const myHandle = resolveMyHandle(config);
  if (myHandle) {
    const myTweets = tweets.filter(
      (t) => t.authorHandle === myHandle && !t.isRetweet
    );
    if (myTweets.length > 0) {
      myPostsAdded = appendMyPosts(myTweets, myHandle);
    }
  }

  // Auto-add discovered accounts
  if (discoveredAccounts.length > 0) {
    const updated = loadAccounts();
    for (const handle of discoveredAccounts) {
      if (!updated.accounts.some((a) => a.handle.toLowerCase() === handle)) {
        updated.accounts.push({ handle, category: "discovered" });
      }
    }
    saveAccounts(updated);
  }

  // Update sync timestamp
  const syncState = readSyncState("private", "context", "twitter") ?? {};
  syncState.lastSync = new Date().toISOString();
  writeSyncState(syncState, "private", "context", "twitter");

  return { total, accounts: updatedAccounts, discovered: discoveredAccounts, myPostsAdded, newTweets: allNewTweets };
}

// --- --collect mode ---

if (process.argv.includes("--collect")) {
  const creds = getCredentials();

  if (!creds) {
    console.error("Twitter: no cookies configured, skipping");
    process.exit(1);
  }

  try {
    const result = await syncFeed();
    if (result.accounts.length > 0) {
      console.log(`Twitter: ${result.accounts.join(", ")}`);
    }
    if (result.discovered.length > 0) {
      console.log(`Twitter discovered: ${result.discovered.map((h) => `@${h}`).join(", ")}`);
    }
    if (result.myPostsAdded > 0) {
      console.log(`Twitter own posts tracked: +${result.myPostsAdded}`);
    }
    console.log(`${result.total} posts fetched`);

    // Append new tweets to daily inbox
    if (result.newTweets.length > 0) {
      // Group by author for readable formatting
      const byAuthor = new Map<string, Tweet[]>();
      for (const t of result.newTweets) {
        const group = byAuthor.get(t.authorHandle) ?? [];
        group.push(t);
        byAuthor.set(t.authorHandle, group);
      }

      const lines: string[] = [];
      for (const [handle, tweets] of byAuthor) {
        lines.push(`### @${handle}`);
        for (const t of tweets) {
          const text = t.text.replace(/\n/g, " ").slice(0, 500);
          const date = t.date.slice(0, 10);
          lines.push(`- [${date}] ${text}`);
        }
        lines.push("");
      }

      appendToInbox("Twitter", lines.join("\n"));
    }
  } catch (e: any) {
    console.log(`Twitter error: ${e.message}`);
    console.log("0 posts fetched");
  }
  process.exit(0);
}

// --- MCP Server mode ---

const server = new Server(
  { name: "cybos-twitter", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "sync_feed",
      description: "Fetch latest tweets from Following tab and save to vault (max once per hour)",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "read_account",
      description: "Read recent posts from a specific account",
      inputSchema: {
        type: "object" as const,
        properties: {
          handle: { type: "string", description: "Twitter handle without @" },
        },
        required: ["handle"],
      },
    },
    {
      name: "read_feed_summary",
      description: "Read the aggregated feed digest from vault",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "add_account",
      description: "Add a Twitter account to the tracking list",
      inputSchema: {
        type: "object" as const,
        properties: {
          handle: { type: "string" },
          category: { type: "string", description: "Optional category (ai, crypto, founder)" },
        },
        required: ["handle"],
      },
    },
    {
      name: "remove_account",
      description: "Remove a Twitter account from the tracking list",
      inputSchema: {
        type: "object" as const,
        properties: { handle: { type: "string" } },
        required: ["handle"],
      },
    },
    {
      name: "read_my_posts",
      description: "Read your own posted tweets with engagement metrics (views, likes, rt, replies, quotes, bookmarks)",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "set_my_handle",
      description: "Set your Twitter handle so the connector can track your own posts separately",
      inputSchema: {
        type: "object" as const,
        properties: {
          handle: { type: "string", description: "Your Twitter handle without @" },
        },
        required: ["handle"],
      },
    },
    {
      name: "list_accounts",
      description: "List all tracked Twitter accounts",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "sync_my_posts",
      description: "Fetch your own tweets directly from your profile with fresh engagement metrics. Not rate-limited by feed sync cooldown.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "sync_feed": {
      const creds = getCredentials();
      if (!creds) {
        return { content: [{ type: "text", text: "No Twitter cookies configured. Store auth_token and ct0 in Keychain:\n  security add-generic-password -s cybos.twitter -a TWITTER_AUTH_TOKEN -w 'VALUE' -T '' -U\n  security add-generic-password -s cybos.twitter -a TWITTER_CT0 -w 'VALUE' -T '' -U" }] };
      }

      try {
        const result = await syncFeed();
        const lines: string[] = [];
        if (result.total === 0) {
          lines.push("No new posts found.");
        } else {
          lines.push(`Synced ${result.total} new posts.`);
          if (result.accounts.length > 0) lines.push(`Updated: ${result.accounts.join(", ")}`);
          if (result.discovered.length > 0) {
            lines.push(`Discovered & auto-tracking: ${result.discovered.map((h) => `@${h}`).join(", ")}`);
          }
          if (result.myPostsAdded > 0) {
            lines.push(`Own posts tracked: +${result.myPostsAdded}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Twitter sync error: ${e.message}` }] };
      }
    }

    case "read_account": {
      const handle = ((args as any)?.handle ?? "").replace("@", "").toLowerCase();
      const content = readVaultFile("private", "context", "twitter", `${handle}.md`);
      return {
        content: [{
          type: "text",
          text: content ?? `No data for @${handle}. Run sync_feed first.`,
        }],
      };
    }

    case "read_feed_summary": {
      // Scan vault directory for all account files
      const twitterDir = resolveVaultPath("private", "context", "twitter");
      const summaryParts: string[] = [];

      if (existsSync(twitterDir)) {
        const files = readdirSync(twitterDir).filter((f) => f.endsWith(".md")).sort();
        for (const file of files) {
          const handle = file.replace(".md", "");
          const content = readVaultFile("private", "context", "twitter", file);
          if (!content) continue;

          const tweets = content.split("<!-- tweet:").slice(1, 4);
          if (tweets.length > 0) {
            const config = loadAccounts();
            const acct = config.accounts.find((a) => a.handle.toLowerCase() === handle);
            summaryParts.push(`## @${handle}${acct?.category ? ` [${acct.category}]` : ""}\n`);
            for (const t of tweets) {
              const textMatch = t.match(/###.+\n\n([\s\S]*?)\n\n\[Link\]/);
              if (textMatch) summaryParts.push(`- ${textMatch[1].slice(0, 200)}\n`);
            }
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: summaryParts.length > 0
            ? `# Twitter Feed Summary\n\n${summaryParts.join("\n")}`
            : "No feed data yet. Run sync_feed first.",
        }],
      };
    }

    case "read_my_posts": {
      const content = readVaultFile("private", "context", "twitter", "my-posts.md");
      return {
        content: [{
          type: "text",
          text: content ?? "No own posts tracked yet. Set your handle with set_my_handle, then run sync_feed.",
        }],
      };
    }

    case "set_my_handle": {
      const handle = ((args as any)?.handle ?? "").replace("@", "").toLowerCase();
      if (!handle) return { content: [{ type: "text", text: "Error: handle required" }] };
      const config = loadAccounts();
      config.myHandle = handle;
      saveAccounts(config);
      return { content: [{ type: "text", text: `Set your handle to @${handle}. Your posts will be tracked separately on next sync.` }] };
    }

    case "list_accounts": {
      const config = loadAccounts();
      return {
        content: [{
          type: "text",
          text: config.accounts.length === 0
            ? "No accounts tracked yet. Run sync_feed to auto-discover from your timeline."
            : config.accounts.map((a) => `@${a.handle}${a.category ? ` [${a.category}]` : ""}`).join("\n"),
        }],
      };
    }

    case "add_account": {
      const handle = ((args as any)?.handle ?? "").replace("@", "").toLowerCase();
      const category = (args as any)?.category;
      if (!handle) return { content: [{ type: "text", text: "Error: handle required" }] };

      const config = loadAccounts();
      if (config.accounts.some((a) => a.handle === handle)) {
        return { content: [{ type: "text", text: `@${handle} already tracked` }] };
      }

      config.accounts.push({ handle, ...(category ? { category } : {}) });
      saveAccounts(config);
      return { content: [{ type: "text", text: `Added @${handle} to tracking list` }] };
    }

    case "sync_my_posts": {
      const creds = getCredentials();
      if (!creds) {
        return { content: [{ type: "text", text: "No Twitter cookies configured." }] };
      }
      try {
        const result = await syncMyPosts();
        const lines: string[] = [];
        if (result.added > 0) lines.push(`Added ${result.added} new post(s).`);
        if (result.updated > 0) lines.push(`Updated metrics for ${result.updated} existing post(s).`);
        if (result.added === 0 && result.updated === 0) lines.push("No changes — posts already up to date.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Sync error: ${e.message}` }] };
      }
    }

    case "remove_account": {
      const handle = ((args as any)?.handle ?? "").replace("@", "").toLowerCase();
      const config = loadAccounts();
      config.accounts = config.accounts.filter((a) => a.handle !== handle);
      saveAccounts(config);
      return { content: [{ type: "text", text: `Removed @${handle} from tracking list` }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

/**
 * Shared Granola types — used by both the API path (server.ts) and the
 * local-cache scraper (scrape.ts).
 */

export interface GranolaNoteListItem {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
}

export interface GranolaTranscriptSegment {
  text: string;
  source?: string;
  start_timestamp?: number;
  end_timestamp?: number;
}

export interface GranolaNoteDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  summary?: string;
  transcript?: GranolaTranscriptSegment[];
  people?: Array<{ name?: string; email?: string }>;
}

export type GranolaMode = "api" | "scrape";

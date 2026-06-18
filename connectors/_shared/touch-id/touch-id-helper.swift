import LocalAuthentication
import Foundation

let context = LAContext()
var error: NSError?

guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
    fputs("ERROR: Biometry not available - \(error?.localizedDescription ?? "unknown")\n", stderr)
    exit(1)
}

let reason = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "cybOS Lite: approve connector access"

let semaphore = DispatchSemaphore(value: 0)
var success = false

context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { result, authError in
    success = result
    if !result {
        fputs("DENIED: \(authError?.localizedDescription ?? "User cancelled")\n", stderr)
    }
    semaphore.signal()
}

semaphore.wait()
exit(success ? 0 : 2)

// Screen OCR helper for DSH Work.
//
// Captures one on-screen window of a process and returns recognized text lines
// with normalized coordinates. The plugin compiles this file once with
// `swiftc -O` and caches the binary; nothing here is model-facing by itself.
//
// Usage:
//   screen-ocr --list          list candidate windows as JSON
//   screen-ocr --frontmost     print the frontmost application as JSON
//   screen-ocr <pid>           capture and OCR the best window of that pid
//   screen-ocr <pid> <window>  capture and OCR one explicit CGWindowID
//
// Capture relies on Screen Recording permission for the calling process.

import Foundation
import AppKit
import Vision
import CoreGraphics
import ImageIO

struct Line: Codable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

typealias ChosenWindow = (number: UInt32, rect: CGRect, titled: Bool, onScreen: Bool)

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func emit(_ object: Any) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { fail("encode failed") }
    FileHandle.standardOutput.write(data)
    exit(0)
}

func windowInfo(_ info: [String: Any], onScreen: Bool = true, allowSmall: Bool = false) -> (pid: Int32, number: UInt32, owner: String, title: String, rect: CGRect, onScreen: Bool)? {
    guard let pid = info[kCGWindowOwnerPID as String] as? Int32,
          let number = info[kCGWindowNumber as String] as? UInt32,
          let layer = info[kCGWindowLayer as String] as? Int,
          layer == 0,
          let dict = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: dict),
          allowSmall || (rect.width >= 400 && rect.height >= 300)
    else { return nil }
    let owner = info[kCGWindowOwnerName as String] as? String ?? ""
    let title = info[kCGWindowName as String] as? String ?? ""
    return (pid, number, owner, title, rect, onScreen)
}

let onScreen = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let visibleNumbers = Set(onScreen.compactMap { $0[kCGWindowNumber as String] as? UInt32 })
let allWindows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: screen-ocr --list | --frontmost | <pid> [window]") }

if args[1] == "--list" {
    // JSONSerialization only accepts JSON-native values, so build dictionaries
    // here; passing Codable structs crashes with "Invalid type in JSON write".
    let candidates: [[String: Any]] = onScreen.compactMap { info in
        guard let window = windowInfo(info) else { return nil }
        return [
            "pid": Int(window.pid),
            "windowNumber": Int(window.number),
            "owner": window.owner,
            "title": window.title,
            "x": Double(window.rect.origin.x),
            "y": Double(window.rect.origin.y),
            "width": Double(window.rect.width),
            "height": Double(window.rect.height),
            "onScreen": true,
        ]
    }
    emit(candidates)
}

if args[1] == "--frontmost" {
    let app = NSWorkspace.shared.frontmostApplication
    emit([
        "pid": Int(app?.processIdentifier ?? -1),
        "name": app?.localizedName ?? "",
        "bundleId": app?.bundleIdentifier ?? "",
    ])
}

/// Picks the window to capture: an on-screen, titled window wins, and the
/// largest area breaks ties between otherwise similar candidates.
func chooseWindow(pid: Int32, explicit: UInt32?) -> ChosenWindow {
    var best: ChosenWindow?
    for info in allWindows {
        let rawNumber = info[kCGWindowNumber as String]
        let numberValue = (rawNumber as? UInt32) ?? UInt32((rawNumber as? Int) ?? 0)
        let visible = visibleNumbers.contains(numberValue)
        guard let window = windowInfo(info, onScreen: visible, allowSmall: explicit != nil), window.pid == pid else { continue }
        if let explicitWindow = explicit {
            if window.number == explicitWindow { best = (window.number, window.rect, true, visible) }
            continue
        }
        // Prefer a titled, on-screen window: helpers, watermarks and tooltips are
        // untitled and would otherwise win the area comparison on identical bounds.
        let titled = !window.title.isEmpty
        let area = window.rect.width * window.rect.height
        guard let current = best else { best = (window.number, window.rect, titled, visible); continue }
        let currentArea = current.rect.width * current.rect.height
        let better = (window.onScreen && !current.onScreen)
            || (window.onScreen == current.onScreen && titled && !current.titled)
            || (window.onScreen == current.onScreen && titled == current.titled && area > currentArea)
        if better { best = (window.number, window.rect, titled, visible) }
    }
    guard let chosen = best else { fail("no window found for pid \(pid)") }
    return chosen
}

/// Screencaptures the chosen window and returns the encoded PNG bytes.
func screenshot(_ chosen: ChosenWindow, pid: Int32) -> Data {
    let shot = NSTemporaryDirectory() + "dsh-work-screen-\(pid)-\(UUID().uuidString).png"
    defer { try? FileManager.default.removeItem(atPath: shot) }
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-o", "-l", String(chosen.number), shot]
    try? capture.run()
    capture.waitUntilExit()
    let data = try? Data(contentsOf: URL(fileURLWithPath: shot))
    guard capture.terminationStatus == 0, let image = data, !image.isEmpty else {
        if !chosen.onScreen {
            fail("window \(chosen.number) of pid \(pid) is not on the current desktop (minimized or another Space); bring the app to the front and retry")
        }
        fail("capture failed; check Screen Recording permission for the calling app")
    }
    return image
}

guard let pid = Int32(args[1]) else { fail("invalid pid: \(args[1])") }
let explicitWindow = args.count >= 3 ? UInt32(args[2]) : nil
let chosen = chooseWindow(pid: pid, explicit: explicitWindow)
let imageData = screenshot(chosen, pid: pid)
guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("capture failed; check Screen Recording permission for the calling app")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { fail("ocr failed: \(error)") }

var lines: [Line] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { continue }
    let box = observation.boundingBox
    lines.append(Line(
        text: text,
        x: Double(box.origin.x),
        y: Double(1 - box.origin.y - box.height),
        w: Double(box.width),
        h: Double(box.height)
    ))
}
lines.sort { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }

emit([
    "pid": Int(pid),
    "windowNumber": Int(chosen.number),
    "onScreen": chosen.onScreen,
    "bounds": ["x": chosen.rect.origin.x, "y": chosen.rect.origin.y, "width": chosen.rect.width, "height": chosen.rect.height],
    "imageWidth": image.width,
    "imageHeight": image.height,
    "lines": lines.map { ["text": $0.text, "x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h] },
])

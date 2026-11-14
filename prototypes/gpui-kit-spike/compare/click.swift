import Cocoa
let args = CommandLine.arguments
let info=CGWindowListCopyWindowInfo([.optionOnScreenOnly],kCGNullWindowID) as! [[String:Any]]
let owner = args.count > 3 ? args[3] : "gpui-kit-spike"
var ox=0.0, oy=0.0
for w in info { if (w[kCGWindowOwnerName as String] as? String)==owner, (w[kCGWindowLayer as String] as? Int)==0 { let b=w[kCGWindowBounds as String] as! [String:Any]; ox=b["X"] as! Double; oy=b["Y"] as! Double } }
let p = CGPoint(x: ox+Double(args[1])!, y: oy+Double(args[2])!)
for t in [CGEventType.leftMouseDown, .leftMouseUp] { CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap); usleep(60000) }

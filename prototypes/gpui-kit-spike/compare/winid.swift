import Cocoa
let info=CGWindowListCopyWindowInfo([.optionOnScreenOnly],kCGNullWindowID) as! [[String:Any]]
for w in info { let o=w[kCGWindowOwnerName as String] as? String ?? ""; if (o=="TeamClu"||o=="gpui-kit-spike") && (w[kCGWindowLayer as String] as? Int)==0 { print(o, w[kCGWindowNumber as String]!, (w[kCGWindowBounds as String] as! [String:Any])["Width"]!, (w[kCGWindowBounds as String] as! [String:Any])["Height"]!) } }

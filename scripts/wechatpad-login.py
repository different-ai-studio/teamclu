#!/usr/bin/env python3
"""QR-login a WeChat account on the local iPad-protocol server.

    python3 scripts/wechatpad-login.py [--server http://127.0.0.1:3010] [--device-id 49…]

For the `wechatpad` channel (docs/features/wechatpad.md). Prints the account
wxid to paste into Settings ▸ Channels ▸ WeChat (iPad protocol), and the login
time the channel uses to send more cautiously for the first two days.
Keep the printed device id and pass it to every later login: a new device id
is what the protocol's risk control reads as a new device.

The QR is rendered from the server's QrBase64 and opened locally. The QrUrl it
also returns points at a third-party QR site and would hand it the login uuid.
"""
import argparse, base64, hashlib, json, random, string, subprocess, sys, tempfile, time, urllib.request

def post(server, path, body=None):
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(server + "/api" + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:3010")
    ap.add_argument("--device-id")
    ap.add_argument("--device-name", default="Oliver Smith's iPad")
    a = ap.parse_args()
    device_id = a.device_id or "49" + hashlib.md5("".join(random.choice(string.ascii_letters) for _ in range(15)).encode()).hexdigest()[2:]

    r = post(a.server, "/Login/LoginGetQR", {"DeviceID": device_id, "DeviceName": a.device_name, "LoginType": "ipad",
                                            "Proxy": {"ProxyIp": "", "ProxyUser": "", "ProxyPassword": ""}})
    if not r.get("Success"):
        sys.exit(f"LoginGetQR failed: {r.get('Code')} {r.get('Message')}")
    uuid = r["Data"]["Uuid"]
    qr = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    qr.write(base64.b64decode(r["Data"]["QrBase64"].split(",", 1)[-1])); qr.close()
    subprocess.run(["open", qr.name])
    print("Scan the QR with the account's phone and confirm…", file=sys.stderr)

    deadline, last = time.time() + 300, None
    while time.time() < deadline:
        r = post(a.server, f"/Login/LoginCheckQR?uuid={uuid}")
        d = r.get("Data")
        status = d.get("status") if isinstance(d, dict) else None
        if status != last:
            print(f"  status {status} {r.get('Message')}", file=sys.stderr); last = status
        acct = d.get("acctSectResp") if isinstance(d, dict) else None
        if acct and acct.get("userName"):
            wxid = acct["userName"]
            hb = post(a.server, f"/Login/AutoHeartBeat?wxid={wxid}")
            print(f"Logged in as {wxid}; heartbeat: {hb.get('Message')}", file=sys.stderr)
            print(json.dumps({"account_wxid": wxid, "login_at": int(time.time()),
                              "device_id": device_id, "device_name": a.device_name},
                             ensure_ascii=False, indent=2))
            return
        time.sleep(3)
    sys.exit("QR expired; run again with --device-id " + device_id)

if __name__ == "__main__":
    main()

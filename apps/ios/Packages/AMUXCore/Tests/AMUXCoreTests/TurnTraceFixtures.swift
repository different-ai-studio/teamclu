import Foundation

/// A trace in the daemon's line format (`apps/daemon/src/runtime/turn_trace.rs`),
/// with one malformed line, gzipped by Python's `gzip` module so the decoder
/// is checked against an encoder other than Apple's.
enum TurnTraceFixtures {
    static let lines: [String] = [
        #"{"turn_seq":1,"type":"status_change","ts_ms":1789000000000,"old_status":"idle","new_status":"active"}"#,
        #"{"turn_seq":2,"type":"thinking","ts_ms":1789000000100,"sequence":12,"model":"claude-sonnet-5","text":"Let me look at the repo."}"#,
        #"{"turn_seq":3,"type":"reply","ts_ms":1789000000200,"sequence":13,"model":"claude-sonnet-5","text":"Checking the tests first."}"#,
        #"{"turn_seq":4,"type":"tool_call","ts_ms":1789000000300,"sequence":14,"tool_id":"call-1","tool_name":"bash","tool_kind":"execute","status":"pending","raw_input":{"command":"ls -la","timeout":30}}"#,
        #"{"turn_seq":5,"type":"permission_request","ts_ms":1789000000400,"sequence":15,"request_id":"perm-1","tool_name":"bash","description":"Run ls -la"}"#,
        #"{"turn_seq":6,"type":"tool_call","ts_ms":1789000000500,"sequence":16,"tool_id":"call-1","tool_name":"bash","tool_kind":"execute","status":"completed","raw_output":{"exit_code":0}}"#,
        #"{"turn_seq":7,"type":"tool_result","ts_ms":1789000000600,"sequence":17,"tool_id":"call-1","success":true,"summary":"total 8\ndrwxr-xr-x  3 me  staff  96 ."}"#,
        #"{"turn_seq":8,"type":"tool_result","ts_ms":1789000000700,"sequence":18,"tool_id":"call-2","success":false,"summary":"No such file"}"#,
        #"{"turn_seq":9,"type":"error","ts_ms":1789000000800,"message":"rate limited","details":"429"}"#,
        #"{"turn_seq":10,"type":"reply","ts_ms":1789000000900,"sequence":19,"model":"claude-sonnet-5","text":"All tests pass.","text_original_size":300000}"#,
        #"{"turn_seq":11,"type":"#,
        #"{"turn_seq":11,"type":"status_change","ts_ms":1789000001000,"old_status":"active","new_status":"idle"}"#,
        #"{"turn_seq":12,"type":"trace_truncated","ts_ms":1789000001100,"dropped_events":3}"#,
    ]

    static var jsonl: Data { Data((lines.joined(separator: "\n") + "\n").utf8) }

    /// `gzip.compress(jsonl, mtime=0)`: no optional header fields, like flate2's GzEncoder.
    static let gzipBase64 = "H4sIAAAAAAAC/61UPW/bMBDd8ysIzXEQWf6St6Jr0aFzAYIlzxYRilTJU2zX8H/vUVYUm1YQDxG8+L7euzveO2bYessD/M3W+WOGhwaydRZQYBu4rITdQkbmwOtAActV+fz2PWbOKH6OpBStTIy0sHu3CYn6FbLTw/ECZTqgYKXti7bbMYA8AlB8C1ZSbE5ZtVNgKE0a0SqYBGct4GQes2GP5PgByGpgxrkXJpBhBcxD454SAsVAgLzmMIY+TdCLO9C/VyBjNx0uQsDANtoHTOFn7/07Z7gUxoxRKBIKMS3GaxVJUNIkz3qTFXUs90eE6s1ERGIc7EG2GPcy7KQBq84z92LHtW1aIn/MpKtr0eWYwCZGxEK6Bhe9xfPpuoX50EIDvtYhaGe5j1wDjvUyS3qh/D763E6s8lE7CoL0ukGCIOOv1rKe4DWlxX1TnSdMFl80VRpfYwBB9XOlufWDhb1GLunxZOt0jMtrzh5Ca0bnt0hYL0dZh1ZKCJSIvoX4lzbqD111FIatflvld3s/iT/GingqjBrYbBgrFyx9pqt7yS0TcqsbctNLchthwhW7n46Rs6JjMalUlAMH8N75MfRVRK+psth2Fy2QBEDX+rwKBSi0iQuaTcukeP78uQ6USW/lHTrwzZj+/BsRwlPv4M7rrbbC8KD/Qbyp+CWMBgH+wPypLue3utxrcKLMnVon6BfC7IUETs/ISnEe5A1Qp8/Ku6YBxeEVLJK7OD38B0fdARNQBgAA"
    static let gzipSHA256 = "96539c9690fcd284c5dc2ca6a93cd3df5e4f84ea0d9a0b1ad3b1c7306712719c"
    static let gzipSize = 567

    /// Same content written through `GzipFile(filename=...)`, so FNAME is set.
    static let gzipWithFileNameBase64 = "H4sICAAAAAAC/3RyYWNlLmpzb25sAK1UPW/bMBDd8ysIzXEQWf6St6Jr0aFzAYIlzxYRilTJU2zX8H/vUVYUm1YQDxG8+L7euzveO2bYessD/M3W+WOGhwaydRZQYBu4rITdQkbmwOtAActV+fz2PWbOKH6OpBStTIy0sHu3CYn6FbLTw/ECZTqgYKXti7bbMYA8AlB8C1ZSbE5ZtVNgKE0a0SqYBGct4GQes2GP5PgByGpgxrkXJpBhBcxD454SAsVAgLzmMIY+TdCLO9C/VyBjNx0uQsDANtoHTOFn7/07Z7gUxoxRKBIKMS3GaxVJUNIkz3qTFXUs90eE6s1ERGIc7EG2GPcy7KQBq84z92LHtW1aIn/MpKtr0eWYwCZGxEK6Bhe9xfPpuoX50EIDvtYhaGe5j1wDjvUyS3qh/D763E6s8lE7CoL0ukGCIOOv1rKe4DWlxX1TnSdMFl80VRpfYwBB9XOlufWDhb1GLunxZOt0jMtrzh5Ca0bnt0hYL0dZh1ZKCJSIvoX4lzbqD111FIatflvld3s/iT/GingqjBrYbBgrFyx9pqt7yS0TcqsbctNLchthwhW7n46Rs6JjMalUlAMH8N75MfRVRK+psth2Fy2QBEDX+rwKBSi0iQuaTcukeP78uQ6USW/lHTrwzZj+/BsRwlPv4M7rrbbC8KD/Qbyp+CWMBgH+wPypLue3utxrcKLMnVon6BfC7IUETs/ISnEe5A1Qp8/Ku6YBxeEVLJK7OD38B0fdARNQBgAA"

    /// The plain member with FEXTRA, FNAME, FCOMMENT and FHCRC spliced into its header.
    static let gzipWithAllHeaderFieldsBase64 = "H4sIHgAAAAAC/wQAQUICAG5hbWUuanNvbmwAYSBjb21tZW50AAAArVQ9b9swEN3zKwjNcRBZ/pK3omvRoXMBgiXPFhGKVMlTbNfwf+9RVhSbVhAPEbz4vt67O947Zth6ywP8zdb5Y4aHBrJ1FlBgG7ishN1CRubA60ABy1X5/PY9Zs4ofo6kFK1MjLSwe7cJifoVstPD8QJlOqBgpe2LttsxgDwCUHwLVlJsTlm1U2AoTRrRKpgEZy3gZB6zYY/k+AHIamDGuRcmkGEFzEPjnhICxUCAvOYwhj5N0Is70L9XIGM3HS5CwMA22gdM4Wfv/TtnuBTGjFEoEgoxLcZrFUlQ0iTPepMVdSz3R4TqzUREYhzsQbYY9zLspAGrzjP3Yse1bVoif8ykq2vR5ZjAJkbEQroGF73F8+m6hfnQQgO+1iFoZ7mPXAOO9TJLeqH8PvrcTqzyUTsKgvS6QYIg46/Wsp7gNaXFfVOdJ0wWXzRVGl9jAEH1c6W59YOFvUYu6fFk63SMy2vOHkJrRue3SFgvR1mHVkoIlIi+hfiXNuoPXXUUhq1+W+V3ez+JP8aKeCqMGthsGCsXLH2mq3vJLRNyqxty00tyG2HCFbufjpGzomMxqVSUAwfw3vkx9FVEr6my2HYXLZAEQNf6vAoFKLSJC5pNy6R4/vy5DpRJb+UdOvDNmP78GxHCU+/gzuuttsLwoP9BvKn4JYwGAf7A/Kku57e63GtwosydWifoF8LshQROz8hKcR7kDVCnz8q7pgHF4RUskrs4PfwHR90BE1AGAAA="

    static var gzip: Data { Data(base64Encoded: gzipBase64)! }
}

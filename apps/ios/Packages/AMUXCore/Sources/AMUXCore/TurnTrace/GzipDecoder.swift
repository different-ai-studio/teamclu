import Compression
import Foundation

/// Minimal single-member gzip (RFC 1952) decoder over Apple's Compression
/// framework, whose `COMPRESSION_ZLIB` is raw DEFLATE: the gzip header and
/// trailer are parsed here and only the DEFLATE body goes to the framework.
///
/// The CRC-32 in the trailer is not checked — callers verify the compressed
/// bytes' SHA-256 before decoding — but ISIZE is, which catches a stream that
/// decodes cleanly yet stops short.
enum GzipDecoder {
    private static let headerLength = 10
    private static let trailerLength = 8

    static func decompress(_ data: Data, maxOutputBytes: Int) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= headerLength + trailerLength,
              bytes[0] == 0x1f, bytes[1] == 0x8b,
              bytes[2] == 8 // CM = deflate
        else { throw TurnTraceError.malformedGzip }

        let flags = bytes[3]
        guard flags & 0xE0 == 0 else { throw TurnTraceError.malformedGzip }
        let trailerStart = bytes.count - trailerLength
        var offset = headerLength

        if flags & 0x04 != 0 { // FEXTRA
            guard offset + 2 <= trailerStart else { throw TurnTraceError.malformedGzip }
            offset += 2 + (Int(bytes[offset]) | Int(bytes[offset + 1]) << 8)
        }
        for flag: UInt8 in [0x08, 0x10] where flags & flag != 0 { // FNAME, FCOMMENT
            guard let end = bytes[min(offset, trailerStart)..<trailerStart].firstIndex(of: 0) else {
                throw TurnTraceError.malformedGzip
            }
            offset = end + 1
        }
        if flags & 0x02 != 0 { offset += 2 } // FHCRC
        guard offset <= trailerStart else { throw TurnTraceError.malformedGzip }

        let expectedSize = UInt32(bytes[trailerStart + 4])
            | UInt32(bytes[trailerStart + 5]) << 8
            | UInt32(bytes[trailerStart + 6]) << 16
            | UInt32(bytes[trailerStart + 7]) << 24
        guard Int(expectedSize) <= maxOutputBytes else { throw TurnTraceError.tooLarge }

        let output = try inflate(bytes, from: offset, to: trailerStart, maxOutputBytes: maxOutputBytes)
        guard UInt32(truncatingIfNeeded: output.count) == expectedSize else {
            throw TurnTraceError.malformedGzip
        }
        return output
    }

    private static func inflate(_ bytes: [UInt8], from start: Int, to end: Int, maxOutputBytes: Int) throws -> Data {
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw TurnTraceError.malformedGzip
        }
        defer { compression_stream_destroy(stream) }

        let chunkSize = 64 * 1024
        let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
        defer { chunk.deallocate() }

        var output = Data()
        try bytes.withUnsafeBufferPointer { input in
            guard let base = input.baseAddress else { throw TurnTraceError.malformedGzip }
            stream.pointee.src_ptr = base + start
            stream.pointee.src_size = end - start
            while true {
                stream.pointee.dst_ptr = chunk
                stream.pointee.dst_size = chunkSize
                let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                guard status == COMPRESSION_STATUS_OK || status == COMPRESSION_STATUS_END else {
                    throw TurnTraceError.malformedGzip
                }
                let produced = chunkSize - stream.pointee.dst_size
                guard output.count + produced <= maxOutputBytes else { throw TurnTraceError.tooLarge }
                output.append(chunk, count: produced)
                if status == COMPRESSION_STATUS_END { return }
                // All input consumed, nothing produced, stream not ended: the
                // DEFLATE body is truncated. Without this the loop never exits.
                if produced == 0, stream.pointee.src_size == 0 { throw TurnTraceError.malformedGzip }
            }
        }
        return output
    }
}

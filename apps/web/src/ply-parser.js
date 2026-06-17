// Parses a binary Gaussian-splat PLY and returns particle data.
// Reads only the vertex element: x/y/z positions and f_dc_0/1/2 (SH DC → RGB).
// Scopes property parsing strictly to the vertex element so stride is correct
// even when the file contains extra elements (extrinsic, intrinsic, image_size…).

const SH_C0 = 0.28209479177387814;

const TYPE_BYTES = { float: 4, double: 8, int: 4, uint: 4, short: 2, ushort: 2, uchar: 1, char: 1 };

export async function parseSplatPly(url, maxParticles = 100_000) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const decode = (s, e) => new TextDecoder("ascii").decode(bytes.slice(s, e));

  // Find end_header in the first 8 KB
  const END = "end_header";
  let dataStart = 0;
  for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
    if (decode(i, i + END.length) === END) {
      dataStart = i + END.length;
      while (dataStart < bytes.length && (bytes[dataStart] === 13 || bytes[dataStart] === 10)) dataStart++;
      break;
    }
  }

  const header = decode(0, dataStart);

  // Extract vertex count
  const vmatch = header.match(/element vertex (\d+)/);
  if (!vmatch) return null;
  const total = parseInt(vmatch[1]);

  // Parse ONLY the properties that belong to the vertex element.
  // Stop collecting once the next element line is reached.
  let stride = 0;
  const off = {};
  let inVertex = false;

  for (const line of header.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("element vertex")) {
      inVertex = true;
      continue;
    }
    if (trimmed.startsWith("element ") && !trimmed.startsWith("element vertex")) {
      inVertex = false; // entered a different element — stop collecting
      continue;
    }
    if (!inVertex) continue;

    const m = trimmed.match(/^property (\w+) (\w+)$/);
    if (!m) continue;
    const [, type, name] = m;
    off[name] = { o: stride, t: type };
    stride += TYPE_BYTES[type] ?? 4;
  }

  if (!off.x || !off.y || !off.z) return null;

  // Uniform subsampling to maxParticles
  const step  = Math.max(1, Math.ceil(total / maxParticles));
  const count = Math.ceil(total / step);
  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);

  const dv = new DataView(buffer, dataStart);
  let pi = 0;

  for (let i = 0; i < total && pi < count; i += step) {
    const b = i * stride;
    positions[pi * 3]     = dv.getFloat32(b + off.x.o, true);
    positions[pi * 3 + 1] = dv.getFloat32(b + off.y.o, true);
    positions[pi * 3 + 2] = dv.getFloat32(b + off.z.o, true);

    if (off.f_dc_0) {
      colors[pi * 3]     = Math.max(0, Math.min(1, dv.getFloat32(b + off.f_dc_0.o, true) / SH_C0 * 0.5 + 0.5));
      colors[pi * 3 + 1] = Math.max(0, Math.min(1, dv.getFloat32(b + off.f_dc_1.o, true) / SH_C0 * 0.5 + 0.5));
      colors[pi * 3 + 2] = Math.max(0, Math.min(1, dv.getFloat32(b + off.f_dc_2.o, true) / SH_C0 * 0.5 + 0.5));
    } else {
      colors[pi * 3] = 0.3; colors[pi * 3 + 1] = 0.6; colors[pi * 3 + 2] = 1.0;
    }
    pi++;
  }

  return { positions, colors, count: pi };
}

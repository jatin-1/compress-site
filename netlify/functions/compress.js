const sharp = require('sharp');
const convert = require('heic-convert');

const TARGET = 900000; // bytes, must stay below the 1 MB batch limit

// Allowed Salesforce origins. Override in Netlify: Site settings > Environment variables
// ALLOWED_ORIGINS = https://yourorg.lightning.force.com,https://yourorg--sbx.sandbox.lightning.force.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://eil--partial.sandbox.lightning.force.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const corsHeaders = (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin'
  };
};

// HEIC/HEIF files (iPhone). AVIF uses brand "avif" and is handled by sharp directly.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];
const isHeic = (buf) =>
  buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp' &&
  HEIC_BRANDS.includes(buf.toString('ascii', 8, 12));

// [maxWidth, quality] tried in order until the result is under TARGET
const ATTEMPTS = [[1600, 80], [1600, 70], [1600, 60], [1600, 50],
                  [1280, 70], [1024, 70], [800, 70], [800, 50]];
// GIF has no quality setting, so only the size shrinks
const ATTEMPTS_NO_QUALITY = [[1600, 0], [1280, 0], [1024, 0], [800, 0], [640, 0]];

const encode = (img, fmt, q) => {
  switch (fmt) {
    case 'png':  return img.png({ palette: true, quality: q, compressionLevel: 9, effort: 7 });
    case 'webp': return img.webp({ quality: q });
    case 'gif':  return img.gif({ effort: 7 });
    case 'tiff': return img.tiff({ compression: 'jpeg', quality: q });
    case 'heif': return img.avif({ quality: q });   // AVIF
    default:     return img.jpeg({ quality: q, mozjpeg: true });
  }
};

exports.handler = async (event) => {
  const CORS = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  try {
    const { url } = JSON.parse(event.body || '{}');
    const host = new URL(url).hostname;
    if (!/\.(force|salesforce)\.com$/.test(host)) {
      return { statusCode: 400, headers: CORS, body: 'URL not allowed' };
    }

    const res = await fetch(url);
    if (!res.ok) return { statusCode: 502, headers: CORS, body: 'Download failed: ' + res.status };
    let input = Buffer.from(await res.arrayBuffer());

    // HEIC -> JPEG first, then handled like any other JPEG
    let convertedFromHeic = false;
    if (isHeic(input)) {
      input = Buffer.from(await convert({ buffer: input, format: 'JPEG', quality: 0.9 }));
      convertedFromHeic = true;
    }

    const opts = { limitInputPixels: 300000000, failOn: 'none' };
    const meta = await sharp(input, opts).metadata();
    const fmt = meta.format; // jpeg, png, webp, gif, tiff, heif (= avif)
    if (!['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif'].includes(fmt)) {
      return { statusCode: 415, headers: CORS, body: 'Unsupported format: ' + fmt };
    }

    const animated = fmt === 'gif' || fmt === 'webp';
    const attempts = fmt === 'gif' ? ATTEMPTS_NO_QUALITY : ATTEMPTS;

    for (const [width, quality] of attempts) {
      const out = await encode(
        sharp(input, { ...opts, animated }).rotate().resize({ width, withoutEnlargement: true }),
        fmt, quality
      ).toBuffer();

      if (out.length <= TARGET) {
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base64: out.toString('base64'),
            size: out.length,
            ext: convertedFromHeic ? 'jpg' : null
          })
        };
      }
    }
    return { statusCode: 422, headers: CORS, body: 'Could not get under target size' };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: String(e.message || e) };
  }
};
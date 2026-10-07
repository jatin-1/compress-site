const sharp = require('sharp');
const TARGET = 900000;

// Replace with your Lightning domain, e.g. https://yourorg.lightning.force.com
const CORS = {
  'Access-Control-Allow-Origin': 'https://eil--partial.sandbox.lightning.force.com',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  try {
    const { url } = JSON.parse(event.body || '{}');
    const host = new URL(url).hostname;
    // only fetch from Salesforce file domains
    if (!/\.(force|salesforce)\.com$/.test(host)) {
      return { statusCode: 400, headers: CORS, body: 'URL not allowed' };
    }

    const res = await fetch(url);
    if (!res.ok) return { statusCode: 502, headers: CORS, body: 'Download failed: ' + res.status };
    const input = Buffer.from(await res.arrayBuffer());

    let width = 1600, quality = 80;
    for (let i = 0; i < 12; i++) {
      const out = await sharp(input, { limitInputPixels: false })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (out.length <= TARGET) {
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64: out.toString('base64'), size: out.length })
        };
      }
      if (quality > 50) quality -= 10;
      else if (width > 800) { width = Math.round(width * 0.8); quality = 70; }
      else break;
    }
    return { statusCode: 422, headers: CORS, body: 'Could not get under target' };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: String(e.message || e) };
  }
};

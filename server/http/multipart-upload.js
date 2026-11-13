// Takes the one uploaded file out of a multipart form body, with its name and type.

const path = require('node:path');

function parseMultipartBackground(req, body, fieldName = 'background') {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!match) throw new Error('Missing multipart boundary');

  const boundaryText = match[1] || match[2];
  const boundary = Buffer.from(`--${boundaryText}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextBoundaryPrefix = Buffer.from(`\r\n--${boundaryText}`);
  let offset = body.indexOf(boundary);

  while (offset !== -1) {
    let partStart = offset + boundary.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) break;
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2;

    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd === -1) break;
    const headers = body.slice(partStart, headerEnd).toString('latin1');
    const dataStart = headerEnd + separator.length;
    const dataEnd = body.indexOf(nextBoundaryPrefix, dataStart);
    if (dataEnd === -1) break;

    const disposition = headers.match(/content-disposition:\s*([^\r\n]+)/i);
    const name = disposition && disposition[1].match(/name="([^"]+)"/i);
    const filename = disposition && disposition[1].match(/filename="([^"]*)"/i);
    if (name && name[1] === fieldName && filename && filename[1]) {
      const typeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
      return {
        originalName: path.basename(filename[1]).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 120) || fieldName,
        contentType: typeMatch ? typeMatch[1].trim().toLowerCase() : '',
        data: body.slice(dataStart, dataEnd),
      };
    }
    offset = body.indexOf(boundary, dataEnd);
  }
  throw new Error(`Missing ${fieldName} file`);
}

module.exports = { parseMultipartBackground };

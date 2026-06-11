/* Generates a real JPEG containing GPS + DateTimeOriginal EXIF, for testing the
 * Reporter photo pipeline (EXIF extraction -> location). Dev-only fixture. */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const piexif = require('piexifjs');

const LAT = 35.6586;   // Tokyo Tower
const LON = 139.7454;
const OUT = path.join(__dirname, '..', 'public', 'test-fixtures', 'gps-sample.jpg');

function toDMSRational(dec) {
  dec = Math.abs(dec);
  const d = Math.floor(dec);
  const mf = (dec - d) * 60;
  const m = Math.floor(mf);
  const s = Math.round((mf - m) * 60 * 100);
  return [[d, 1], [m, 1], [s, 100]];
}

(async () => {
  // 1. Make a small solid-colour raster and encode to JPEG (pure JS, no native).
  const width = 64, height = 64;
  const frame = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    frame[i * 4] = 190; frame[i * 4 + 1] = 70; frame[i * 4 + 2] = 70; frame[i * 4 + 3] = 255;
  }
  const encoded = jpeg.encode({ data: frame, width, height }, 85).data; // Buffer

  // 2. Build EXIF with GPS + capture time, insert into the JPEG.
  const gps = {};
  gps[piexif.GPSIFD.GPSLatitudeRef] = LAT >= 0 ? 'N' : 'S';
  gps[piexif.GPSIFD.GPSLatitude] = toDMSRational(LAT);
  gps[piexif.GPSIFD.GPSLongitudeRef] = LON >= 0 ? 'E' : 'W';
  gps[piexif.GPSIFD.GPSLongitude] = toDMSRational(LON);

  const zeroth = {};
  zeroth[piexif.ImageIFD.Make] = 'GroundTruthTestCam';
  zeroth[piexif.ImageIFD.Model] = 'Fixture-1';

  const exif = {};
  exif[piexif.ExifIFD.DateTimeOriginal] = '2026:06:01 09:30:00';

  const exifStr = piexif.dump({ '0th': zeroth, Exif: exif, GPS: gps });
  const jpegBinary = encoded.toString('binary');
  const withExif = piexif.insert(exifStr, jpegBinary);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(withExif, 'binary'));
  console.log('Wrote', OUT, fs.statSync(OUT).size, 'bytes');

  // 3. Verify with exifr that GPS round-trips.
  const exifr = await import('exifr');
  const buf = fs.readFileSync(OUT);
  const g = await exifr.gps(buf);
  const meta = await exifr.parse(buf, { pick: ['DateTimeOriginal'] });
  console.log('exifr GPS read back:', g);
  console.log('exifr DateTimeOriginal:', meta && meta.DateTimeOriginal);
})();

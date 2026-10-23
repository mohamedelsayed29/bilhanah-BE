import sharp from 'sharp';
import { processImage, renditionWidths, sniffImageType } from './image-processing.js';

const jpeg = (width: number, height: number, orientation?: number) => {
  const image = sharp({ create: { width, height, channels: 3, background: '#c0392b' } }).jpeg();
  return (orientation ? image.withMetadata({ orientation }) : image).toBuffer();
};

describe('sniffImageType', () => {
  it('identifies images by content, not by name', async () => {
    expect(sniffImageType(await jpeg(10, 10))).toBe('jpeg');
    expect(sniffImageType(await sharp({ create: { width: 4, height: 4, channels: 4, background: '#fff' } }).png().toBuffer())).toBe('png');
    expect(sniffImageType(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).webp().toBuffer())).toBe('webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('renditionWidths', () => {
  it('renders every target narrower than the upload', () => {
    expect(renditionWidths('ITEM', 3000)).toEqual([320, 640, 1280]);
  });

  it('adds the upload width when it is smaller than the largest target', () => {
    expect(renditionWidths('ITEM', 800)).toEqual([320, 640, 800]);
    expect(renditionWidths('ITEM', 250)).toEqual([250]);
    expect(renditionWidths('ITEM', 1280)).toEqual([320, 640, 1280]);
  });
});

describe('processImage', () => {
  it('writes WebP renditions without metadata', async () => {
    const result = await processImage(await jpeg(1600, 1200), 'ITEM');

    expect(result).toMatchObject({ width: 1600, height: 1200 });
    expect(result.renditions.map((r) => [r.width, r.height])).toEqual([[320, 240], [640, 480], [1280, 960]]);
    const meta = await sharp(result.renditions[0]!.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
  });

  it('applies EXIF rotation', async () => {
    // Stored landscape, displayed portrait (orientation 6 = rotate 90 degrees).
    const result = await processImage(await jpeg(800, 400, 6), 'ITEM');
    expect(result).toMatchObject({ width: 400, height: 800 });
    expect(result.renditions.at(-1)).toMatchObject({ width: 400, height: 800 });
  });

  it('rejects files that are not decodable images', async () => {
    const truncated = (await jpeg(400, 400)).subarray(0, 200);
    await expect(processImage(truncated, 'ITEM')).rejects.toThrow();
  });
});

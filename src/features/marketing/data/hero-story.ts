// Timings match scripts/build-hero-video.mjs. Every chapter uses filmed footage.
export const heroStory = {
  src: '/media/hero-live-v1.mp4',
  duration: 14.08,
  initialChapter: 1,
  startAt: 3.45,
  chapters: [
    { at: 0, poster: '/media/hero-live-scan.jpg', position: '48% center' },
    { at: 2.8, poster: '/media/hero-live-menu.jpg', position: '34% center' },
    { at: 8.48, poster: '/media/hero-live-food.jpg', position: '48% center' },
  ],
} as const;

export function chapterAtTime(time: number) {
  if (time >= heroStory.chapters[2].at) return 2;
  if (time >= heroStory.chapters[1].at) return 1;
  return 0;
}

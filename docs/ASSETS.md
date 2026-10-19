# Visual Assets

The current hero is a 14.08-second edit of **real filmed stock footage**, not animated photographs or generated video. It shows natural hand and phone motion in three chapters. It is silent H.264 at 1280 × 720, 25 fps, approximately 1.48 MB. Short crossfades join the filmed shots; there are no still-image loops or synthetic camera pans.

## Current hero video: sources and license

| Chapter | Source | Creator | Selected source interval |
| --- | --- | --- | --- |
| Scan the QR | [A Person Scanning a QR Code](https://www.pexels.com/video/a-person-scanning-a-qr-code-5226464/) | Gunjee Nyam | 0–3.12 seconds |
| Explore the menu | [A woman is using an iPhone to show a menu](https://www.pexels.com/video/a-woman-is-using-an-iphone-to-show-a-menu-5077084/) | cottonbro studio | 14–20 seconds |
| Food and phone | [A Person Taking Photos of the Food](https://www.pexels.com/video/a-person-taking-photos-of-the-food-6953896/) | cottonbro studio | 2–7.6 seconds |

Source license: [Pexels License](https://www.pexels.com/license/), checked 2026-10-19. These are illustrative stock scenes, not a claim that the people, restaurants, brands, or app interfaces shown endorse Bilhanah.

Final video: `public/media/hero-live-v1.mp4`. Chapter boundaries: 0, 2.8, and 8.48 seconds. See `src/features/marketing/data/hero-story.ts`.

Fallback/reduced-motion posters `hero-live-scan.jpg`, `hero-live-menu.jpg`, and `hero-live-food.jpg` are frames extracted from the respective footage, not generated restaurant photographs. Normal playback uses only moving footage.

Rebuild with `node scripts/build-hero-video.mjs <source-directory>` after downloading the three originals as `bilhanah-scan-source.mp4`, `bilhanah-menu-source.mp4`, and `bilhanah-food-source.mp4`. The build script itself makes no network requests. Large originals are kept outside the repository.

## Earlier generated imagery

The previously rejected animated-still hero has been retired. The generated `ready.jpg` is still used in the illustrative menu cover; the other generated photos are retained as source assets only and do not appear in the hero. Their native generation prompts remain below for provenance.

Generated source PNGs remain at the native tool's original save paths. Optimized project JPEGs live in `public/media/`. The former `hero-story.mp4` is no longer served or referenced by the page.

## Generated scenes and exact prompts

### scan

- Project file: `public/media/scan.jpg`
- Original: `/Users/test/.codex/generated_images/01a1544f-62b6-7210-b0ec-18163b081e3d/exec-2f822e73-9947-4b1b-b5c5-f683d6acd216.png`

Use case: photorealistic-natural. Asset type: cinematic restaurant landing page background, widescreen 1536x1024 or 16:9. A contemporary elegant Egyptian/Mediterranean restaurant, warm natural evening sunlight, honey oak table, dark teal upholstery #075E54, warm ivory ceramics, small guava coral touches #FF7868. Premium editorial commercial photography, realistic human anatomy and hands, 35mm film feel without grain effects, shallow depth of field, natural delicious food, no watermarks, no overlaid text, no logos. Action and objects concentrated in the LEFT 60 percent, RIGHT 40 percent is defocused dark teal restaurant interior with clean quiet space for website headline. Must look like a real cinematic lifestyle photo, not a 3D render. Scene 1: a fashionable young Egyptian man seated at a beautiful restaurant table in left half of frame, three-quarter side/back angle, holding a modern black smartphone with both hands and aiming its camera at a small upright ivory table tent displaying a large crisp black QR code on a teal square. Phone tilted towards card. Subtle blurred diners and warm pendant lights behind, fresh plate and drinking water beside the card. Inviting authentic candid moment. Wide environmental view with compelling phone and QR focal point.

### explore

- Project file: `public/media/explore.jpg`
- Original: `/Users/test/.codex/generated_images/01a1544f-62b6-7210-b0ec-18163b081e3d/exec-b8d13be8-2b4c-42c0-83c3-e261614e3375.png`

Use case: photorealistic-natural. Asset type: cinematic restaurant landing page background, widescreen 1536x1024 or 16:9. A contemporary elegant Egyptian/Mediterranean restaurant, warm natural evening sunlight, honey oak table, dark teal upholstery #075E54, warm ivory ceramics, small guava coral touches #FF7868. Premium editorial commercial photography, realistic human anatomy and hands, 35mm film feel without grain effects, shallow depth of field, natural delicious food, no watermarks, no overlaid text, no logos. Action and objects concentrated in the LEFT 60 percent, RIGHT 40 percent is defocused dark teal restaurant interior with clean quiet space for website headline. Must look like a real cinematic lifestyle photo, not a 3D render. Scene 2: close over-the-shoulder detail of a diner's hand holding a beautiful black smartphone at a restaurant table on the LEFT half of the image. Screen shows a refined ivory and teal mobile restaurant menu with beautiful full-color food photography thumbnails, short readable labels 'Menu', 'Chicken', 'Pasta', prices '180', '145', three distinct food entries. Thumb poised to scroll the menu. A delicious grilled chicken bowl partly visible below. Hand and phone occupy left center with tactile photorealistic detail, right half remains dark defocused teal restaurant background. High-end food-tech brand campaign.

### ready

- Project file: `public/media/ready.jpg`
- Original: `/Users/test/.codex/generated_images/01a1544f-62b6-7210-b0ec-18163b081e3d/exec-880af215-2dba-4b91-8dc6-46748beb29ed.png`

Use case: photorealistic-natural. Asset type: cinematic restaurant landing page background, widescreen 1536x1024 or 16:9. A contemporary elegant Egyptian/Mediterranean restaurant, warm natural evening sunlight, honey oak table, dark teal upholstery #075E54, warm ivory ceramics, small guava coral touches #FF7868. Premium editorial commercial photography, realistic human anatomy and hands, 35mm film feel without grain effects, shallow depth of field, natural delicious food, no watermarks, no overlaid text, no logos. Action and objects concentrated in the LEFT 60 percent, RIGHT 40 percent is defocused dark teal restaurant interior with clean quiet space for website headline. Must look like a real cinematic lifestyle photo, not a 3D render. Scene 3: luxurious tabletop still life photographed at a 35 degree angle, a black smartphone on the LEFT of the frame resting next to a beautiful warm ivory ceramic plate with grilled chicken, fresh green herbs, cherry tomatoes and golden roasted potatoes. The smartphone screen displays a beautiful teal and ivory mobile restaurant menu with one appetizing photo. Upright small ivory QR card further back. A hand lightly rests near the plate. Glass of water, linen napkin, warm oak and honey sunlight. Real appetizing gourmet meal. Keep ALL focal elements in left half, right half spacious dark defocused restaurant.

## Sample-menu food photographs

Sample restaurant, dish names, and dish prices are illustrative demo content. No restaurant adoption or customer testimonial is claimed.

- `public/media/burger.jpg`: [Unsplash source](https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=700&q=85).
- `public/media/pasta.jpg`: [Unsplash source](https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=700&q=85).
- `public/media/salad.jpg`: [Unsplash source](https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=700&q=85).


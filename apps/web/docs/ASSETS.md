# Visual Assets

## Stand shop shape photographs

- `public/media/nfc-arch-v1.jpg` (880×1100): arch silhouette, selected original `/Users/test/.codex/generated_images/01a15a8a-cb86-77a3-aba4-5f0cdfff00cd/exec-f5eb8def-7cb9-4ef6-a517-c26cc75644a9.png`.
- `public/media/nfc-tilt-v1.jpg` (880×1100): leaning L-shaped stand, selected original `/Users/test/.codex/generated_images/01a15a8a-cb86-77a3-aba4-5f0cdfff00cd/exec-434cda89-4a45-408c-895c-d87601b35a27.png`.
- Generated using built-in ImageGen, referencing the existing classic acrylic product photograph for brand/material consistency. Final prompts are `.impeccable/prompts/stand-shop/arch.txt` and `tilt.txt`. JPEGs were resized/converted using sips without cropping.
- Catalog photos are illustrative and labeled accordingly. The separate live design preview is CSS geometry with the existing Phosphor icon system and a real locally generated QR. It does not raster-edit the catalog images. The live QR and downloaded SVG encode the shopper’s selected valid web URL.

## QR and NFC acrylic table stands

- `public/media/nfc-acrylic-table-v1.jpg` (1536×1024, about 319 KB): illustrative product photograph of a clear acrylic QR/NFC stand on a restaurant table beside a pasta dish.
- `public/media/nfc-acrylic-detail-v1.jpg` (880×1100, about 151 KB): matching product detail on a warm ivory studio background.
- Generated with the built-in `image_gen` tool using the supplied Bilhanah logo as an identity reference. Exact prompts: `.impeccable/prompts/nfc-stands/table.txt`, `table-qr-correction.txt`, and `detail.txt`. JPEG conversions use sips; images are not cropped in the shipping files.
- Original selected PNGs: `/Users/test/.codex/generated_images/01a15a8a-cb86-77a3-aba4-5f0cdfff00cd/exec-3f538f7e-68df-4ea9-bdc6-a1dc202d8c08.png` and `/Users/test/.codex/generated_images/01a15a8a-cb86-77a3-aba4-5f0cdfff00cd/exec-e721c7d9-8db1-4ffa-b7e8-129ffa7d9b2b.png`.
- The user confirmed they offer acrylic stands with a QR code and an embedded NFC chip. Images are labeled illustrative concepts, not actual product photography. Pictured QR patterns are illustrative and are not advertised as functional demo links. No dimensions, prices, lead times, customization options or plan inclusion are claimed.

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


## Supplied brand logo

`public/brand/bilhanah-logo-original.png` is the original 1692×930 logo supplied by the user on 2026-10-20 (attachment `codex-clipboard-6ff44897-90bd-4183-a786-4cbaf3aef285.png`). No redraw or pixel transformation is used. Origin metadata is embedded; CSS hides only the blank outer margin, using a 1507×479 display viewport beginning at source coordinates (104,231). It is preserved as the source for the SVG conversion described below. The original CSS margin crop has been replaced by the SVG’s tight viewBox.

## Vector logo

`public/brand/bilhanah-logo.svg` is traced locally from the supplied raster using Potrace. It contains two actual vector paths, not a base64 image wrapper. The viewBox is 1507×479, the background is transparent, and shapes use Deep Teal #075E54 and Guava #FF7868. The lettering is outlined, with no font or external asset dependency. Flat brand colors replace the raster’s texture and lighting variation; the original shape is traced rather than recreated from a font.

Reproduce locally with `scripts/vectorize-logo.mjs`; its header documents temporary npm tools and the exact command. Tooling is kept outside the application’s runtime dependencies. The header and footer use this SVG.

## White logo and reference composition

`public/brand/bilhanah-logo-light.svg` uses the same traced paths as the teal vector logo, with the teal layer changed to white for dark/video backgrounds. Guava accents remain unchanged. `scripts/vectorize-logo.mjs` now writes both variants. Header uses the white variant; footer retains the teal variant.

The layout reference was supplied by the user as `/Users/test/Downloads/Bilhanah Arabic Food-Tech Hero.png` (1586×992). It guides composition only and is not embedded as the background. The existing real filmed video remains active; initial playback seeks to the menu chapter at 3.45s. The menu frame is preloaded for the fallback/loading state. No source media or project was uploaded.

## Food-truck closing campaign image

- Shipping asset: `public/media/food-truck-order-ready-v1.jpg` (1672×941, about 388KB), converted lossily from the selected generated PNG without cropping.
- Original generated file: `/Users/test/.codex/generated_images/01a1544f-62b6-7210-b0ec-18163b081e3d/exec-06529b69-6b7f-4ab7-84dd-597ce07c1747.png`. Project copy: `.impeccable/review/food-truck-order-ready-original.png`.
- Generated using the built-in image_gen tool. Exact prompt: `.impeccable/prompts/food-truck-order-ready.txt` at the project root; also embedded in the shipping JPEG’s COM metadata.
- User requested a food truck with an exterior QR sign, customers sitting at outdoor tables, and phones vibrating to indicate an order is ready. The image depicts this with an Arabic order-ready notification, checkmarks and restrained vibration marks. It is illustrative campaign imagery, not an actual customer photograph or proof of device behavior. The pictured QR sign is illustrative; the site’s existing sample-menu QR remains the functional demo.
- On desktop the photograph fills the former green closing band, with existing page copy and CTA on its quiet right side. Mobile shows the scene above the existing text, preserving the truck QR and foreground phone.

## Procedural stand models

The shop's interactive 360° models are generated in `src/features/stand-shop/stand-scene.ts` using Three.js geometry and acrylic materials. Classic, Arch and Tilt do not depend on an external model file or remote model service. Front/back canvas textures are drawn locally in `stand-artwork.ts` using the selected design, local logo and functional QR. Existing shape photographs remain thumbnails and the fallback for browsers without WebGL. Geometry and dimensions are illustrative; no manufacturing accuracy is claimed.

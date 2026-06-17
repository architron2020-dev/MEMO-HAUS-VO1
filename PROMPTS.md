# Memo-Haus — Prompt Log

All prompts submitted in this project, in order from the very beginning.

---

0. we are building an app. I want you to help us. This project is about people scanning a qr code leading to a webpage where they can upload their old photos of Wolfsburg, then this photo is sent to backend to transform it to a gaussian splat using ml-sharp library, and then there is also a page which interactively shows the last converted gaussian splat from the storage on backend. it's gonna be a monorepo project. i want to be able to start everything with a simple npm run dev command. on upload page i want to see a button for upload, image name field and author field. as user presses upload the image is sent to backend. there ml-sharp is converting it to a gaussian splat and saves it to some storage (let it be a server). the viewer page automatically checks for the last converted gaussian splat and loads it instead of the previous one. for reference i uploaded archive/frontend and archive/ml-sharp. please use them but put in correct structure of this repo. modify frontend as you need, don't stick to it completely. if you need to modify somthing for clarity or better structure or maintainability - do it.

1. i just downloaded this project, can you start it? install everything needed. i have nvifisa rtx 3050 ti laptop.
2. dont use skills
3. i allow
4. hey is this a mono repo?
5. okay dont completely copy or clone apple sharp just use apple sharp 3d gaussian splatting as a method for this project library reference okay..?
6. no then dont delete
7. give me the command to run the app manually
8. change the name of the project as Memo-Haus
9. RESOLVE THIS ERROR AND ATTACH ALL THE SUPPORTING REQUIREMENTS TO SOLVE THIS ERROR AND GENERATE THE UI
10. did ypu design 2 different storage one for uploaded and one for splatted one?
11. okay keep storage for the uploads from the mobile ui page that uploads folder rename the folder as Memo-album and splatted folder as Memo-splatted
12. caption the project as From Archive To Participatory Experience.
13. hey can you create a particle animation like like rafik anadol work ..but here the uloaded image from upload ui after getting splatted forms particle animation of the splatted gaussians fly from the places they need to come from move and constructs to form the 3d splat and disorts and reconstructs the same way when the 3d splats changes to another 3d splat again same repeat
14. what happend to the animation
15. hey undo the particle animation and replace with creation of smooth particle disintergration effect and construction effect in changing the memories and make it smooth and experential
16. resolve this error (screenshot — Failed to fetch on upload form)
17. CONTINUE
18. when the 3d splat is appearing show as particles getting constructed and changing to another splat the existing splat gets particle gaussian disintegration and the new splat constructs and same in repeat smooth what you have done before is not working by applying partcile system physics and animation and smoother velocity experience
19. okay proceed
20. what happend to the animation
21. okay proceed
22. hey can you create a particle animation like rafik anadol work (repeated)
23. still hanging — torch... okay pause the transition particle animation now and run the interface in gpu
24. nvidia rtx 3050 ti gpu my laptop
25. solve the windows security isssue by yourself
26. hey exclusion done
27. pause lets continue this later
28. resume and finish all the process quickly you have been running for so long and the interface was working fine before and now its not working make it work
29. are you done with cuda api all those long process resolved?
30. so tell me all are done right?
31. remove this (screenshot — "or take one now" text)
32. just give option of uploading the photo only
33. Share an old photo of Wolfsburg and watch it come alive as an interactive 3D scene. rephrase this properly as per the project as the photo should not only always be old so its like share your memories in wolfsburg from your archive to experience something thats creative simple
34. looks like it doesnt have a complete sentence make it complete
35. hey store all the prompts given here by me in first prompt md to see the record of all the prompts given to check and visit back and automatically record the upcoming prompts as well to the first prompt md in order from start till now and upcoming
36. when the user is uploading the memory and the backend is generating it dont leave the viewer ui in black screen just run the other memories that has been already splatted and make transition between between the memories smooth like gaussians constructing to form the scene and again moving away changing and constructing again to form the another memory and each memory should display for 1min and show a round loading symbol for the time in viewer ui to make the user aware
37. push all the prompts from first prompt md to prompts md as they were the first before so include that as well
38. the spinning wheel should run for one min when it displays the memory that helps the user to be aware of the time it stays in the viewer
39. add the prompts from first prompt md to the prompts md in first
40. hey watch this video the strating particle disintegration and reintegration transition apply this physics to the scene transition
41. can i download the video so can you watch?
42. Create a cinematic scene transition where the current scene breaks into thousands of glowing particles, disperses through space, and then reforms into the next scene. The particles should detach from edges first, float, swirl, scatter, and move as if controlled by invisible forces like wind, gravity, and magnetic attraction. Then they gradually slow down and reconnect into the new scene, forming outlines, surfaces, light, and depth. do this to the viewer ui
43. i cant see the transition animation
44. still the transition is not working resolve it and make it work
45. hey i guess the transition of particle dis integration is not good remove it remove the ball particles glowing particles all the particle effect given by the reference and make it normal like how it was working before the particle animation
46. okay this is an urban design project suggest me something how can we make this more interesting like interactive and experiential
47. noo give recommendations for the interface to proceed then lets proceed with the pavilion
48. Full-screen immersion, minimal chrome — no UI chrome, cinematic transitions, kiosk mode (cursor hidden), vignette. Execute this — make it more interactive and amazing.
49. [screenshot of forming Gaussian splat scene] this scene forming transition apply for all the next upcoming transitions of scenes
50. no its not working
51. include that 1 min time wheel small with processing pill as well
52. make the ring more smaller
53. [screenshot of space game sci-fi UI] add the memory text in small typography in sci-fi theme typo in bottom and display the text and position the wheel near it and stay until the next memory scene displays like the ref image attached and show
54. design a logo for both the interface
55. make fonts more bold and visible and the typo and the letters should appear like getting typed for every scene and the typo and the wheel should take colours from the scenes and colours vary for every scene to tackle visibility and if the picture is black and white then retain the most visible bright colour for all the black and white other colour pictures take the contrast and bright colour for the typo and the wheel
56. now execute everything that is said all now ui typo etc and update all the prompts to prompts md as well looks like its not updated
57. okay add these features to the mobile ui such name of the person, memory of the year, a small memory story behind it

---

## Current UI specification (as of prompt 56)

### Viewer page (`viewer.html`)
- Full-screen Gaussian splat kiosk display, `cursor: none`
- Cinematic vignette (radial gradient overlay, z-index 5)
- Black transition overlay fades to black then reveals new scene with 2200ms ease-in (splat materialises visibly)
- `progressiveLoad: true` — PLY streams, splats form in real time during overlay lift
- Scene dwell: 60 seconds per scene, then advance to next (loops)
- New uploads interrupt the rotation and transition in immediately

### Scene HUD (bottom-left, `#scene-hud`)
- Font: `"Courier New"` monospace
- Layout: `[SVG ring 26×26] [text block]` flex row, `bottom: 36px; left: 36px`
- Text block: `---- MEMORY ACTIVE ----` header → `NAME  <value>` → `BY  <value>`
- **Typewriter**: characters typed one by one (55ms/char name, 48ms/char author), blinking `█` cursor, cursor fades after 1.2s
- **Dynamic colour**: source image drawn to 80×80 canvas, HSL-sampled for most saturated non-dark/non-blown pixel → boosted to L=0.70, S×1.3 → applied as `--hc: r, g, b` CSS variable
- B&W / desaturated (saturation < 0.14): fallback bright cyan `rgb(17, 124, 255)`
- HUD hides during transition overlay, shows after PLY loads

### Timer ring
- SVG `r=10`, circumference 62.8, `stroke-dashoffset` 62.8→0 over 60s via rAF
- Starts counting only after PLY finishes loading
- Colour from `--hc` via `stroke: rgba(var(--hc), 0.82)`; glow via inline filter

### Logo
- `public/logo.svg`: orbital mark + `MEMO / HAUS` wordmark + `MEMORY ARCHIVE SYSTEM` tagline
- `public/favicon.svg`: mark only, 32×32 on black
- Used on viewer placeholder and upload card; favicon linked in both HTML pages

### Typography weights
- `hud-value`: 0.90rem, weight 700, `rgba(--hc, 1.0)`
- `hud-label`: 0.62rem, weight 700, `rgba(--hc, 0.55)`
- `hud-status`: 0.62rem, weight 700, `rgba(--hc, 0.50)`
- Author: 0.78rem, weight 600, `rgba(--hc, 0.72)`

### Backend changes
- `storage.py`: `Scene.image_url` → `/uploads/<filename>`
- `main.py`: `_serialize()` includes `image_url`; `/uploads` static mount
- `vite.config.js`: `/uploads` proxy added

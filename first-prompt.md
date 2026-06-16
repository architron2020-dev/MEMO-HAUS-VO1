we are building an app. I want you to help us. This project is about people scanning a qr code leading to a webpage where they can upload their old photos of Wolfsburg, then this photo is sent to backend to transform it to a gaussian splat using ml-sharp library, and then there is also a page which interactively shows the last converted gaussian splat from the storage on backend.

it's gonna be a monorepo project. i want to be able to start everything with a simple npm run dev command.

on upload page i want to see a button for upload, image name field and author field. as user presses upload the image is sent to backend. there ml-sharp is converting it to a gaussian splat and saves it to some storage (let it be a server). the viewer page automatically checks for the last converted gaussian splat and loads it instead of the previous one.


for reference i uploaded archive/frontend and archive/ml-sharp. please use them but put in correct structure of this repo. modify frontend as you need, don't stick to it completely. if you need to modify somthing for clarity or better structure or maintainability - do it.
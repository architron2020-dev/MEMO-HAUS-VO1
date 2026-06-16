import "./upload.css";

const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const nameInput = document.getElementById("name-input");
const authorInput = document.getElementById("author-input");
const uploadButton = document.getElementById("upload-button");
const statusEl = document.getElementById("status");
const imagePreview = document.getElementById("image-preview");
const dropzoneHint = document.getElementById("dropzone-hint");

let selectedFile = null;

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] ?? null;
  uploadButton.disabled = !selectedFile;

  if (selectedFile) {
    imagePreview.src = URL.createObjectURL(selectedFile);
    imagePreview.classList.add("visible");
    dropzoneHint.classList.add("hidden");
  } else {
    imagePreview.classList.remove("visible");
    dropzoneHint.classList.remove("hidden");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;

  setBusy(true);
  setStatus("Uploading photo and generating the 3D scene — this can take a minute…", "pending");

  try {
    const formData = new FormData();
    formData.append("image", selectedFile);
    formData.append("name", nameInput.value);
    formData.append("author", authorInput.value);

    const response = await fetch("/api/predict", { method: "POST", body: formData });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${detail}`);
    }

    const scene = await response.json();
    setStatus(
      `Done! “${scene.name}” is now live in the viewer. You can share another photo.`,
      "success",
    );
    resetForm();
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message}`, "error");
  } finally {
    setBusy(false);
  }
});

function setBusy(busy) {
  uploadButton.disabled = busy || !selectedFile;
  uploadButton.textContent = busy ? "Generating…" : "Upload & Generate";
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind ?? "";
}

function resetForm() {
  selectedFile = null;
  fileInput.value = "";
  imagePreview.classList.remove("visible");
  imagePreview.removeAttribute("src");
  dropzoneHint.classList.remove("hidden");
  uploadButton.disabled = true;
}

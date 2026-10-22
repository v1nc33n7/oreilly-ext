const key = document.getElementById("key") as HTMLInputElement;
const msg = document.getElementById("msg")!;
document.getElementById("save")!.addEventListener("click", async () => {
  const v = key.value.trim();
  if (!v) { msg.textContent = "Empty key not saved"; return; }
  await chrome.storage.local.set({ openrouterApiKey: v });
  msg.textContent = "Saved";
});

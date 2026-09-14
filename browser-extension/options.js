(async () => {
  const data = await chrome.storage.local.get(['label', 'profileFolder']);
  document.querySelector('#label').value = data.label || 'Vivaldi';
  document.querySelector('#folder').value = data.profileFolder || 'Default';
})();
document.querySelector('form').onsubmit = async e => {
  e.preventDefault();
  const profileFolder = document.querySelector('#folder').value.trim();
  if (!/^(Default|Profile \d+)$/.test(profileFolder)) {
    document.querySelector('#status').textContent =
      'Use Default or Profile followed by its number.';
    return;
  }
  await chrome.storage.local.set({
    label: document.querySelector('#label').value.trim().slice(0, 80) || 'Vivaldi',
    profileFolder,
  });
  document.querySelector('#status').textContent = 'Saved. Open Browser on your phone.';
};

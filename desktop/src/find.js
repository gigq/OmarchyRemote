const input = document.querySelector('input');
const output = document.querySelector('output');
input.value = new URLSearchParams(location.search).get('q') || '';
const send = (action, backwards = false) =>
  window.findBar.send({ action, query: input.value, backwards });
input.oninput = () => send('query');
input.onkeydown = event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    send('next', event.shiftKey);
  } else if (event.key === 'Escape') send('close');
};
for (const button of document.querySelectorAll('button'))
  button.onclick = () =>
    button.dataset.action === 'close'
      ? send('close')
      : send('next', button.dataset.action === 'previous');
window.findBar.onResult(({ index, total }) => {
  output.textContent = !input.value ? '' : total ? `${index} of ${total}` : 'No matches';
});
input.focus();
input.select();
if (input.value) send('query');

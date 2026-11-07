export function createDitherAccents(): DocumentFragment {
  const frag = document.createDocumentFragment();

  const ditherTL = document.createElement('img');
  ditherTL.className = 'dither-corner dither-top-left';
  ditherTL.src = '/art/sweep.png';
  ditherTL.alt = '';
  ditherTL.setAttribute('aria-hidden', 'true');

  const ditherTR = document.createElement('img');
  ditherTR.className = 'dither-corner dither-top-right';
  ditherTR.src = '/art/sweep.png';
  ditherTR.alt = '';
  ditherTR.setAttribute('aria-hidden', 'true');

  const ditherBL = document.createElement('img');
  ditherBL.className = 'dither-corner dither-bottom-left';
  ditherBL.src = '/art/sweep.png';
  ditherBL.alt = '';
  ditherBL.setAttribute('aria-hidden', 'true');

  frag.appendChild(ditherTL);
  frag.appendChild(ditherTR);
  frag.appendChild(ditherBL);

  return frag;
}

const $circle = document.querySelector('.card__circle');
const $year = document.querySelector('.card__year');
const $card = document.querySelector('.card');
const $cardOrangeShine = document.querySelector('.card__orangeShine');
const $cardThankYou = document.querySelector('.card__thankyou');
const $cardComet = document.querySelector('.card__cometOuter');

const generateTranslate = (el, e, value) => {
  el.style.transform = `translate(${e.clientX * value}px, ${e.clientY * value}px)`;
};
const cumulativeOffset = element => {
  var top = 0,left = 0;
  do {
    top += element.offsetTop || 0;
    left += element.offsetLeft || 0;
    element = element.offsetParent;
  } while (element);

  return {
    top: top,
    left: left };

};
document.onmousemove = event => {
  const e = event || window.event;
  const x = (e.pageX - cumulativeOffset($card).left - 350 / 2) * -1 / 100;
  const y = (e.pageY - cumulativeOffset($card).top - 350 / 2) * -1 / 100;

  const matrix = [
  [1, 0, 0, -x * 0.00005],
  [0, 1, 0, -y * 0.00005],
  [0, 0, 1, 1],
  [0, 0, 0, 1]];


  generateTranslate($cardThankYou, e, 0.03);
  generateTranslate($cardOrangeShine, e, 0.09);
  generateTranslate($circle, e, 0.05);
  generateTranslate($year, e, 0.03);
  generateTranslate($cardComet, e, 0.05);

  $card.style.transform = `matrix3d(${matrix.toString()})`;
};
(function () {
  document.body.classList.remove('no-js');
  var nav = document.querySelector('.nav');
  var onScroll = function () { if (nav) nav.classList.toggle('scrolled', window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  var y = document.getElementById('y'); if (y) y.textContent = new Date().getFullYear();

  // 练习热力图（演示数据，固定种子，保证每次一致）
  var heat = document.getElementById('heat');
  if (heat) {
    var seed = 7, html = '';
    for (var i = 0; i < 31; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      var r = seed / 233280, lv = r < 0.22 ? 0 : r < 0.45 ? 1 : r < 0.75 ? 2 : 3;
      html += '<i class="l' + lv + '" title="10 月 ' + (i + 1) + ' 日"></i>';
    }
    heat.innerHTML = html;
  }

  var els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach(function (e) { io.observe(e); });
})();


/* global Intl */
(function () {
  'use strict';
  var body = document.body;
  var screen = document.querySelector('.screen');
  var focuses = document.querySelectorAll('[data-focus]');
  var rails = document.querySelectorAll('[data-rail]');
  var seconds = Number(body.getAttribute('data-rotate')) || 25;
  var lastSuccess = Number(body.getAttribute('data-last-success'));
  var staleAfter = Number(body.getAttribute('data-stale-after'));
  var revision = body.getAttribute('data-revision');
  var timezone = body.getAttribute('data-timezone');
  var position = 0,
    elapsed = 0,
    connected = true,
    pending = false,
    checking = false,
    refreshing = false;
  function resize() {
    var portrait = window.innerWidth < window.innerHeight;
    var width = portrait ? 1080 : 1920,
      height = portrait ? 1920 : 1080;
    var scale = Math.min(window.innerWidth / width, window.innerHeight / height);
    screen.style.transform = 'scale(' + scale + ')';
    screen.style.marginLeft = Math.max(0, (window.innerWidth - width * scale) / 2) + 'px';
  }
  function refreshStatus() {
    var stale = !lastSuccess || Date.now() / 1000 - lastSuccess > staleAfter;
    document.getElementById('status').textContent = !connected
      ? 'Connection unavailable'
      : stale
        ? 'Feed stale'
        : 'Feed current';
    document.getElementById('status-dot').className = 'dot' + (stale || !connected ? ' stale' : '');
    document.getElementById('checked').textContent =
      'Last successful check: ' +
      (lastSuccess
        ? new Date(lastSuccess * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        : 'not yet');
  }
  function refreshBoard() {
    if (refreshing) return;
    refreshing = true;
    var request = new XMLHttpRequest();
    request.open('GET', '/tv' + window.location.search);
    request.timeout = 10000;
    request.onload = function () {
      refreshing = false;
      try {
        if (request.status !== 200) throw new Error('HTTP');
        var next = new DOMParser().parseFromString(request.responseText, 'text/html');
        var nextScreen = next.querySelector('.screen');
        if (!nextScreen || !next.body.getAttribute('data-revision'))
          throw new Error('Invalid board');
        // Replace only a fully received, server-rendered screen. Never navigate
        // away from usable content when a connection drops during refresh.
        screen.innerHTML = nextScreen.innerHTML;
        focuses = screen.querySelectorAll('[data-focus]');
        rails = screen.querySelectorAll('[data-rail]');
        revision = next.body.getAttribute('data-revision');
        lastSuccess = Number(next.body.getAttribute('data-last-success'));
        staleAfter = Number(next.body.getAttribute('data-stale-after'));
        seconds = Number(next.body.getAttribute('data-rotate')) || 25;
        timezone = next.body.getAttribute('data-timezone');
        position = 0;
        elapsed = 0;
        pending = false;
        connected = true;
      } catch (error) {
        void error;
        connected = false;
      }
      refreshStatus();
    };
    request.onerror = request.ontimeout = function () {
      refreshing = false;
      connected = false;
      refreshStatus();
    };
    request.send();
  }
  function check() {
    if (checking) return;
    checking = true;
    var request = new XMLHttpRequest();
    var query = window.location.search ? window.location.search + '&limit=1' : '?limit=1';
    request.open('GET', '/api/advisories' + query);
    request.timeout = 10000;
    request.onload = function () {
      checking = false;
      try {
        if (request.status !== 200) throw new Error('HTTP');
        var data = JSON.parse(request.responseText);
        connected = true;
        lastSuccess = data.lastSuccess;
        pending = data.contentRevision !== revision;
        if (!focuses.length && pending) refreshBoard();
      } catch (error) {
        connected = false;
        void error;
      }
      refreshStatus();
    };
    request.onerror = request.ontimeout = function () {
      checking = false;
      connected = false;
      refreshStatus();
    };
    request.send();
  }
  setInterval(function () {
    try {
      document.getElementById('clock').textContent = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date());
    } catch (error) {
      void error;
      document.getElementById('clock').textContent =
        new Date().toISOString().slice(11, 16) + ' UTC';
    }
    refreshStatus();
    if (!focuses.length || refreshing) return;
    elapsed++;
    document.getElementById('progress').style.width =
      Math.min(100, (elapsed / seconds) * 100) + '%';
    if (elapsed < seconds) return;
    elapsed = 0;
    // Apply new content after every selected advisory has had its screen time.
    if (pending && connected && position === focuses.length - 1) {
      refreshBoard();
      return;
    }
    focuses[position].hidden = true;
    if (rails[position]) rails[position].classList.remove('active');
    position = (position + 1) % focuses.length;
    focuses[position].hidden = false;
    if (rails[position]) rails[position].classList.add('active');
    document.getElementById('position').textContent = position + 1 + ' / ' + focuses.length;
  }, 1000);
  setInterval(check, 15000);
  window.addEventListener('resize', resize);
  resize();
  refreshStatus();
  check();
})();

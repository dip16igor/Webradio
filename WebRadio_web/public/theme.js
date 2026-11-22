/* Shared light/dark theme. Loaded synchronously in <head> so the stored
 * theme applies before first paint (no flash). Toggle buttons only need
 * a data-theme-btn attribute — wiring is automatic. */
(function () {
    var KEY = 'webradio_theme';
    function current() {
        try { return localStorage.getItem(KEY) || 'dark'; }
        catch (e) { return 'dark'; }
    }
    function apply(t) {
        document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
        var m = document.querySelector('meta[name="theme-color"]');
        if (m) m.content = t === 'light' ? '#f4f7f6' : '#141414';
    }
    function paintBtns() {
        var t = current();
        Array.prototype.forEach.call(document.querySelectorAll('[data-theme-btn]'), function (b) {
            b.textContent = t === 'light' ? '☀️' : '🌙';
        });
    }
    apply(current());
    window.WebRadioTheme = {
        toggle: function () {
            var n = current() === 'light' ? 'dark' : 'light';
            try { localStorage.setItem(KEY, n); } catch (e) { /* noop */ }
            apply(n);
            paintBtns();
            return n;
        },
        current: current,
        apply: apply
    };
    document.addEventListener('DOMContentLoaded', function () {
        paintBtns();
        Array.prototype.forEach.call(document.querySelectorAll('[data-theme-btn]'), function (b) {
            b.addEventListener('click', function () { window.WebRadioTheme.toggle(); });
        });
    });
})();

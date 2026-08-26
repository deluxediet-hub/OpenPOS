/* kds-boot.js — standalone kitchen/bar display page.
   Loads the shared KDS module and boots it as a full-screen ticket screen. */
'use strict';

(function () {
  const script = document.createElement('script');
  script.src = '/assets/kds.js';
  script.onload = () => KDS.bootStandalone();
  document.body.appendChild(script);
})();

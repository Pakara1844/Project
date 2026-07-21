(function(){
      const t = localStorage.getItem('cbank-theme') || 'light';
      document.documentElement.setAttribute('data-theme', t);
    })();

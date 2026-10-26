(() => {
  const OPTIONS = window.ITR_OPTIONS;
  const ENDPOINT = (window.ITR_CONFIG && window.ITR_CONFIG.endpoint) || '';
  const FALLBACK_CONTACT = 'call or text 810.275.8629';

  const form = document.getElementById('intake-form');
  const submitBtn = document.getElementById('submit');
  const errorBox = document.getElementById('form-error');
  const success = document.getElementById('success');

  const palmCatalog = Object.assign({}, ...Object.values(OPTIONS.palmMaterials));
  const catalogs = { palm: palmCatalog, gusset: OPTIONS.gussetMaterials };
  const PALM_EXTRAS = ['Not sure - recommend one', 'No repalm - mods/repairs only'];

  if (new URLSearchParams(location.search).has('embed')) {
    document.documentElement.classList.add('embed');
    reportHeightToParent();
  }
  if (!ENDPOINT) document.getElementById('demo-note').hidden = false;

  // ---------- Build dropdowns + option lists from options.js ----------
  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  const option = (value, label = value) => el('option', { value, textContent: label });

  document.getElementById('makes').append(...OPTIONS.gloveMakes.map((m) => option(m)));

  form.querySelectorAll('select[data-catalog]').forEach((select) => {
    select.append(option('', 'Select a material'));
    if (select.dataset.catalog === 'palm') {
      for (const [group, materials] of Object.entries(OPTIONS.palmMaterials)) {
        select.append(el('optgroup', { label: group }, Object.keys(materials).map((m) => option(m))));
      }
    } else {
      select.append(...Object.keys(catalogs[select.dataset.catalog]).map((m) => option(m)));
    }
    if ('extras' in select.dataset) {
      select.append(el('optgroup', { label: 'Other' }, PALM_EXTRAS.map((m) => option(m))));
    }
  });

  const choice = (type, name, value, checked = false) =>
    el('label', { className: 'choice' }, [el('input', { type, name, value, checked }), ` ${value}`]);

  form.querySelectorAll('[data-radio-list]').forEach((box) => {
    const name = box.dataset.radioList;
    box.append(choice('radio', name, 'None', true), ...OPTIONS[name].map((v) => choice('radio', name, v)));
  });
  form.querySelectorAll('[data-checkbox-list]').forEach((box) => {
    const name = box.dataset.checkboxList;
    box.append(...OPTIONS[name].map((v) => choice('checkbox', name, v)));
  });

  // ---------- Conditional fields ----------
  function currentValue(name) {
    const field = form.elements[name];
    if (!field) return '';
    if (field instanceof RadioNodeList) return field.value;
    if (field.type === 'checkbox') return field.checked ? field.value : '';
    return field.value;
  }

  function refresh() {
    form.querySelectorAll('[data-show-when]').forEach((node) => {
      const [name, value] = node.dataset.showWhen.split('=');
      node.hidden = currentValue(name) !== value;
    });

    form.querySelectorAll('[data-cascade-for]').forEach((field) => {
      const material = form.elements[field.dataset.cascadeFor];
      const target = field.querySelector('select');
      const choices = catalogs[material.dataset.catalog][material.value] || [];
      if (target.dataset.for !== material.value) {
        target.replaceChildren(option('', 'Select one'), ...choices.map((c) => option(c)));
        target.dataset.for = material.value;
      }
      field.hidden = choices.length === 0;
    });

    // Hidden controls are disabled so they skip validation and stay out of the payload.
    form.querySelectorAll('input, select, textarea').forEach((control) => {
      if (control.name !== 'website') control.disabled = Boolean(control.closest('[hidden]'));
    });
  }

  form.addEventListener('change', refresh);
  refresh();

  // ---------- Submit ----------
  form.addEventListener('invalid', () => form.classList.add('submitted'), true);

  function collect() {
    const data = {};
    for (const [key, value] of new FormData(form)) {
      data[key] = key in data ? [].concat(data[key], value) : value;
    }
    return data;
  }

  async function send(payload) {
    if (!ENDPOINT) {
      console.info('[demo] intake payload', payload);
      await new Promise((r) => setTimeout(r, 500));
      return { ok: true, orderId: 'DEMO-0001' };
    }
    // No Content-Type header: a text/plain POST skips the CORS preflight Apps Script can't answer.
    const res = await fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload) });
    return res.json();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const payload = collect();
    try {
      const result = await send(payload);
      if (!result.ok) throw new Error(result.error || 'Submission failed');
      showSuccess(result.orderId, payload.email);
    } catch (err) {
      console.error(err);
      const detail = err instanceof TypeError ? "We couldn't reach the server." : err.message;
      errorBox.textContent = `${detail} Please try again, or ${FALLBACK_CONTACT}.`;
      errorBox.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Intake Form';
    }
  });

  function showSuccess(orderId, email) {
    document.getElementById('order-id').textContent = orderId;
    document.getElementById('success-email').textContent = email;
    form.hidden = true;
    success.hidden = false;
    success.focus();
    success.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('another').addEventListener('click', () => {
    form.reset();
    form.classList.remove('submitted');
    refresh();
    success.hidden = true;
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- Mobile nav ----------
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.querySelector('.nav-toggle');
  toggle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  // Lets a parent page (e.g. the Weebly site) size the iframe to fit; see README.
  function reportHeightToParent() {
    if (window.parent === window) return;
    const post = () =>
      window.parent.postMessage({ type: 'itr-intake-height', height: document.documentElement.scrollHeight }, '*');
    new ResizeObserver(post).observe(document.body);
  }
})();

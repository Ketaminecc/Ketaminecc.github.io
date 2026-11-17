'use strict';

(function () {
  const params = new URLSearchParams(window.location.search);
  const next = window.KET.safeNext(params.get('next'), '/dashboard.html');
  const form = document.getElementById('auth-form');
  const email = document.getElementById('auth-email');
  const password = document.getElementById('auth-password');
  const nameField = document.getElementById('name-field');
  const confirmField = document.getElementById('confirm-field');
  const name = document.getElementById('auth-name');
  const confirm = document.getElementById('auth-confirm');
  const errorBox = document.getElementById('auth-error');
  const submit = document.getElementById('auth-submit');
  const title = document.getElementById('auth-title');
  const sub = document.getElementById('auth-sub');
  const switchNote = document.getElementById('auth-switch');
  const switchBtn = document.getElementById('switch-btn');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');

  let mode = params.get('mode') === 'register' ? 'register' : 'login';

  function setMode(nextMode) {
    mode = nextMode;
    const register = mode === 'register';
    tabLogin.setAttribute('aria-selected', String(!register));
    tabRegister.setAttribute('aria-selected', String(register));
    title.textContent = register ? 'Create your account' : 'Welcome back';
    sub.textContent = register
      ? 'One account holds every license, order, and expiration date.'
      : 'Sign in to manage licenses and complete checkout.';
    nameField.hidden = !register;
    confirmField.hidden = !register;
    name.required = false;
    confirm.required = register;
    password.autocomplete = register ? 'new-password' : 'current-password';
    submit.textContent = register ? 'Create account' : 'Sign in';
    switchNote.innerHTML = register
      ? 'Already registered? <button type="button" class="link" id="switch-btn" style="background:none;border:0;padding:0;border-bottom:1px solid currentColor">Sign in instead</button>'
      : 'New here? <button type="button" class="link" id="switch-btn" style="background:none;border:0;padding:0;border-bottom:1px solid currentColor">Create an account</button>';
    document.getElementById('switch-btn').addEventListener('click', () => setMode(register ? 'login' : 'register'));
    errorBox.classList.remove('show');
    const url = new URL(window.location.href);
    if (register) url.searchParams.set('mode', 'register');
    else url.searchParams.delete('mode');
    window.history.replaceState({}, '', url);
    (register ? name : email).focus();
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }

  async function checkExisting() {
    const data = await window.KET.me();
    if (data.user) window.location.replace(next);
  }

  tabLogin.addEventListener('click', () => setMode('login'));
  tabRegister.addEventListener('click', () => setMode('register'));
  switchBtn.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.remove('show');
    const emailValue = email.value.trim().toLowerCase();
    const passwordValue = password.value;
    if (!emailValue || !passwordValue) return showError('Enter your email and password.');
    if (mode === 'register') {
      if (passwordValue.length < 8) return showError('Password must be at least 8 characters.');
      if (passwordValue !== confirm.value) return showError('Passwords do not match.');
    }

    submit.disabled = true;
    submit.classList.add('is-loading');
    submit.textContent = mode === 'register' ? 'Creating account…' : 'Signing in…';
    try {
      if (mode === 'register') {
        await window.KET.api('/api/auth/register', {
          method: 'POST',
          body: { email: emailValue, password: passwordValue, displayName: name.value.trim() },
        });
      } else {
        await window.KET.api('/api/auth/login', {
          method: 'POST',
          body: { email: emailValue, password: passwordValue },
        });
      }
      window.location.assign(next);
    } catch (err) {
      showError(err.message || 'Authentication failed. Try again.');
      submit.disabled = false;
      submit.classList.remove('is-loading');
      submit.textContent = mode === 'register' ? 'Create account' : 'Sign in';
    }
  });

  setMode(mode);
  checkExisting();
})();

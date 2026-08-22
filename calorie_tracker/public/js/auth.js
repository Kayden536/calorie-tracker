(async () => {
  const supabase = await window.PulsePlate.ready;
  const { data: { session } } = await supabase.auth.getSession();
  if (session) window.location.href = 'index.html';

  const form = document.querySelector('#authForm');
  const status = document.querySelector('#authStatus');
  const loginTab = document.querySelector('#loginTab');
  const signupTab = document.querySelector('#signupTab');
  const nameField = document.querySelector('#nameField');
  const submit = document.querySelector('#authSubmit');
  let mode = 'login';

  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    loginTab.classList.toggle('active', !signup);
    signupTab.classList.toggle('active', signup);
    nameField.hidden = !signup;
    submit.textContent = signup ? 'Create account' : 'Log in';
    status.textContent = '';
  }
  loginTab.onclick = () => setMode('login');
  signupTab.onclick = () => setMode('signup');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = 'Working…';
    const email = document.querySelector('#email').value.trim();
    const password = document.querySelector('#password').value;
    const displayName = document.querySelector('#displayName').value.trim() || 'PulsePlate User';

    let result;
    if (mode === 'signup') {
      result = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName } }
      });
      if (!result.error && !result.data.session) status.textContent = 'Account created. Check your email to confirm your account, then log in.';
    } else {
      result = await supabase.auth.signInWithPassword({ email, password });
      if (!result.error) window.location.href = 'index.html';
    }
    if (result.error) status.textContent = result.error.message;
  });
})();

(async () => {
  const status = document.querySelector('#authStatus');
  const form = document.querySelector('#authForm');
  const loginTab = document.querySelector('#loginTab');
  const signupTab = document.querySelector('#signupTab');
  const nameField = document.querySelector('#nameField');
  const passwordField = document.querySelector('#passwordField');
  const confirmPasswordField = document.querySelector('#confirmPasswordField');
  const submit = document.querySelector('#authSubmit');
  const forgotPassword = document.querySelector('#forgotPassword');
  const backToLogin = document.querySelector('#backToLogin');
  const password = document.querySelector('#password');
  const confirmPassword = document.querySelector('#confirmPassword');
  const email = document.querySelector('#email');
  const displayName = document.querySelector('#displayName');

  let supabase;
  let mode = 'login';

  function isRecoveryLink() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search);
    return hash.get('type') === 'recovery' || query.get('type') === 'recovery';
  }

  try {
    supabase = await window.PulsePlate.ready;
  } catch (error) {
    status.textContent = error.message;
    return;
  }

  const recovery = isRecoveryLink();

  const { data: { session } } = await supabase.auth.getSession();
  if (session && !recovery) {
    window.location.href = 'index.html';
    return;
  }

  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    const reset = mode === 'reset';
    loginTab.classList.toggle('active', !signup && !reset);
    signupTab.classList.toggle('active', signup);
    loginTab.hidden = reset;
    signupTab.hidden = reset;
    nameField.hidden = !signup;
    passwordField.hidden = false;
    confirmPasswordField.hidden = !reset;
    forgotPassword.hidden = signup || reset;
    backToLogin.hidden = !reset && mode !== 'forgot';
    password.required = mode !== 'forgot';
    confirmPassword.required = mode === 'reset';
    if (mode === 'forgot') {
      loginTab.hidden = true;
      signupTab.hidden = true;
      nameField.hidden = true;
      passwordField.hidden = true;
      confirmPasswordField.hidden = true;
      forgotPassword.hidden = true;
      backToLogin.hidden = false;
      submit.textContent = 'Send reset email';
    } else if (reset) {
      submit.textContent = 'Update password';
      backToLogin.hidden = false;
    } else {
      submit.textContent = signup ? 'Create account' : 'Log in';
      backToLogin.hidden = true;
    }
    status.textContent = '';
  }

  function setForgotMode() {
    mode = 'forgot';
    setMode('forgot');
    document.querySelector('h1').textContent = 'Reset your password';
    document.querySelector('.page-copy').textContent = 'Enter your email and we will send you a secure password reset link.';
  }

  function setRecoveryMode() {
    setMode('reset');
    document.querySelector('h1').textContent = 'Choose a new password';
    document.querySelector('.page-copy').textContent = 'Set a new password for your MacroSync account.';
    password.required = true;
    confirmPassword.required = true;
  }

  loginTab.onclick = () => {
    mode = 'login';
    setMode('login');
    document.querySelector('h1').textContent = 'Welcome';
    document.querySelector('.page-copy').textContent = 'Create an account to save your food diary and goals across devices.';
    password.required = true;
  };

  signupTab.onclick = () => {
    setMode('signup');
    document.querySelector('h1').textContent = 'Create your account';
    document.querySelector('.page-copy').textContent = 'Create an account to save your food diary and goals across devices.';
    password.required = true;
  };

  forgotPassword.onclick = setForgotMode;
  backToLogin.onclick = () => {
    window.history.replaceState({}, '', 'auth.html');
    mode = 'login';
    setMode('login');
    document.querySelector('h1').textContent = 'Welcome';
    document.querySelector('.page-copy').textContent = 'Create an account to save your food diary and goals across devices.';
    password.required = true;
  };

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') setRecoveryMode();
  });

  if (recovery) setRecoveryMode();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = 'Working…';

    try {
      password.required = mode !== 'forgot';
    confirmPassword.required = mode === 'reset';
    if (mode === 'forgot') {
        const address = email.value.trim();
        if (!address) throw new Error('Enter your email address first.');
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const result = await supabase.auth.resetPasswordForEmail(address, { redirectTo });
        if (result.error) throw result.error;
        status.textContent = 'If an account exists for that email, a password reset link has been sent.';
        return;
      }

      if (mode === 'reset') {
        if (password.value.length < 8) throw new Error('Your new password must be at least 8 characters.');
        if (password.value !== confirmPassword.value) throw new Error('The passwords do not match.');
        const result = await supabase.auth.updateUser({ password: password.value });
        if (result.error) throw result.error;
        status.textContent = 'Password updated successfully. Redirecting…';
        window.history.replaceState({}, '', 'auth.html');
        setTimeout(() => { window.location.href = 'index.html'; }, 700);
        return;
      }

      const address = email.value.trim();
      const pass = password.value;
      const name = displayName.value.trim() || 'MacroSync User';
      if (mode === 'signup') {
        const blocked = ['fuck','fucker','fucking','shit','shitter','bitch','bitches','asshole','bastard','cunt','dick','pussy','cock','slut','whore','porn','pornography','nude','nudes','naked','sex','sexual','sexy','onlyfans','rape','rapist','pedo','pedophile','groomer','kill','kys','nazi','slur'];
        const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const tokenName = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!name) throw new Error('Please enter a display name.');
        if (name.length > 80) throw new Error('Display names must be 80 characters or fewer.');
        if (blocked.some(term => tokenName.split(/\s+/).includes(term) || normalizedName === term || normalizedName.includes(term))) {
          throw new Error('That display name contains language or content that is not allowed.');
        }
      }
      let result;

      if (mode === 'signup') {
        result = await supabase.auth.signUp({
          email: address,
          password: pass,
          options: { data: { display_name: name } }
        });
        if (!result.error && !result.data.session) {
          status.textContent = 'Account created. Check your email to confirm your account, then log in.';
        } else if (!result.error) {
          window.location.href = 'index.html';
        }
      } else {
        result = await supabase.auth.signInWithPassword({ email: address, password: pass });
        if (!result.error) window.location.href = 'index.html';
      }

      if (result.error) throw result.error;
    } catch (error) {
      status.textContent = error?.message || 'Something went wrong. Please try again.';
    }
  });
})();

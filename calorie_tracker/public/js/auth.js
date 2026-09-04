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
  const dobField = document.querySelector('#dobField');
  const dateOfBirth = document.querySelector('#dateOfBirth');
  const dobYear = document.querySelector('#dateOfBirthYear');
  const dobMonth = document.querySelector('#dateOfBirthMonth');
  const dobDay = document.querySelector('#dateOfBirthDay');
  const emailLabel = document.querySelector('#emailLabel');
  const emailHelp = document.querySelector('#emailHelp');
  const nameOptionalNote = document.querySelector('#nameOptionalNote');
  const nameHelp = document.querySelector('#nameHelp');
  const signupAgreements = document.querySelector('#signupAgreements');
  const termsAgreement = document.querySelector('#termsAgreement');
  const privacyAgreement = document.querySelector('#privacyAgreement');
  const parentAgreementRow = document.querySelector('#parentAgreementRow');
  const parentAgreement = document.querySelector('#parentAgreement');
  const dobAgeNotice = document.querySelector('#dobAgeNotice');

  let supabase;
  let mode = 'login';

  function setupDatePicker() {
    if (!dobYear || !dobMonth || !dobDay || !dateOfBirth) return;
    const today = new Date();
    const currentYear = today.getFullYear();
    const earliestYear = currentYear - 120;
    dobYear.innerHTML = '<option value="">Year</option>' + Array.from({ length: currentYear - earliestYear + 1 }, (_, i) => {
      const year = currentYear - i;
      return `<option value="${year}">${year}</option>`;
    }).join('');
    dobMonth.innerHTML = '<option value="">Month</option>' + Array.from({ length: 12 }, (_, i) => {
      const value = String(i + 1).padStart(2, '0');
      return `<option value="${value}">${new Date(2000, i, 1).toLocaleString(undefined, { month: 'long' })}</option>`;
    }).join('');

    function refreshDays() {
      const year = Number(dobYear.value);
      const month = Number(dobMonth.value);
      const previous = dobDay.value;
      const daysInMonth = year && month ? new Date(year, month, 0).getDate() : 31;
      dobDay.innerHTML = '<option value="">Day</option>' + Array.from({ length: daysInMonth }, (_, i) => {
        const value = String(i + 1).padStart(2, '0');
        return `<option value="${value}">${i + 1}</option>`;
      }).join('');
      if (Number(previous) <= daysInMonth) dobDay.value = previous;
    }
    function syncDate() {
      if (dobYear.value && dobMonth.value && dobDay.value) dateOfBirth.value = `${dobYear.value}-${dobMonth.value}-${dobDay.value}`;
      else dateOfBirth.value = '';
    }
    dobYear.addEventListener('change', () => { refreshDays(); syncDate(); updateSignupRequirements(); });
    dobMonth.addEventListener('change', () => { refreshDays(); syncDate(); updateSignupRequirements(); });
    dobDay.addEventListener('change', () => { syncDate(); updateSignupRequirements(); });
    refreshDays();
  }

  function calculateAge(dob) {
    if (!dob) return null;
    const birth = new Date(`${dob}T00:00:00`);
    if (Number.isNaN(birth.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
    return age;
  }

  function updateSignupRequirements() {
    if (!signupAgreements) return;
    const signup = mode === 'signup';
    signupAgreements.hidden = !signup;
    if (!signup) {
      if (termsAgreement) termsAgreement.required = false;
      if (privacyAgreement) privacyAgreement.required = false;
      if (parentAgreement) parentAgreement.required = false;
      return;
    }
    const age = calculateAge(dateOfBirth?.value || '');
    const minor = Number.isFinite(age) && age >= 13 && age < 16;
    if (emailLabel) emailLabel.textContent = minor ? 'Parent or legal guardian email' : 'Email';
    if (emailHelp) emailHelp.hidden = !minor;
    if (nameField) nameField.hidden = minor;
    if (displayName) displayName.required = !minor;
    if (nameOptionalNote) nameOptionalNote.textContent = minor ? '(not required)' : '(required)';
    if (nameHelp) nameHelp.textContent = minor ? 'A display name is optional for limited accounts and is not required to use food logging or the food database.' : 'Your display name is shown to other users when social features are available.';
    if (parentAgreementRow) parentAgreementRow.hidden = !minor;
    if (parentAgreement) parentAgreement.required = minor;
    if (termsAgreement) termsAgreement.required = true;
    if (privacyAgreement) privacyAgreement.required = true;
    if (minor) {
      email.autocomplete = 'email';
    }
    updateSubmitState();
  }

  function updateSubmitState() {
    if (!submit) return;
    if (mode !== 'signup') { submit.disabled = false; return; }
    const age = calculateAge(dateOfBirth?.value || '');
    const minor = Number.isFinite(age) && age >= 13 && age < 16;
    const agreementsOk = !!termsAgreement?.checked && !!privacyAgreement?.checked && (!minor || !!parentAgreement?.checked);
    const dobOk = !!dateOfBirth?.value;
    submit.disabled = !(agreementsOk && dobOk);
  }

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

  setupDatePicker();

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
    if (dobField) dobField.hidden = !signup;
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
    updateSignupRequirements();
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
  [termsAgreement, privacyAgreement, parentAgreement].forEach(el => el?.addEventListener('change', updateSubmitState));
  updateSignupRequirements();

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
      const dob = dateOfBirth?.value || '';
      let signupAge = null;
      let limitedMinor = false;
      if (mode === 'signup') {
        const blocked = ['fuck','fucker','fucking','motherfucker','shit','shitty','bullshit','bitch','bitches','asshole','dumbass','bastard','cunt','dick','dickhead','pussy','cock','slut','whore','damn','crap','piss','jackass','asshat','prick','twat','wanker','porn','pornography','nude','nudes','naked','sex','sexual','sexy','onlyfans','sexting','rape','rapist','pedo','pedophile','groomer','nigger','niggers','nigga','niggas','chink','chinks','spic','spics','kike','kikes','gook','gooks','wetback','wetbacks','beaner','beaners','raghead','ragheads','coon','coons','fag','fags','faggot','faggots','dyke','dykes','tranny','trannies','bbc'];
        const leet = {'@':'a','4':'a','3':'e','1':'i','!':'i','0':'o','$':'s','5':'s','7':'t','+':'t','8':'b'};
        const normalize = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[0134578@$!+]/g,c=>leet[c]||c).replace(/[^a-z0-9]/g,'');
        const normalizedName = normalize(name);
        const tokenName = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!dob) throw new Error('Please enter your date of birth.');
        const birth=new Date(`${dob}T00:00:00`), today=new Date();
        let age=today.getFullYear()-birth.getFullYear();
        if(today.getMonth()<birth.getMonth() || (today.getMonth()===birth.getMonth() && today.getDate()<birth.getDate())) age--;
        if(age<13) throw new Error('MacroSync accounts are not available for users under 13.');
        if(age>120) throw new Error('Please enter a valid date of birth.');
        signupAge = age;
        limitedMinor = age < 16;
        if (!limitedMinor && !name.trim()) throw new Error('Please enter a display name.');
        if (!termsAgreement?.checked || !privacyAgreement?.checked) throw new Error('You must agree to the Terms of Service and Privacy Policy before creating an account.');
        if (limitedMinor && !parentAgreement?.checked) throw new Error('A parent or legal guardian agreement is required for users ages 13–15.');
        if (limitedMinor && !address) throw new Error('Enter a parent or legal guardian email address.');
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
          options: { data: { display_name: limitedMinor ? 'MacroSync User' : name, date_of_birth: dob, terms_version: '1.0', privacy_version: '1.0', terms_accepted_at: new Date().toISOString(), privacy_accepted_at: new Date().toISOString(), parental_consent_required: limitedMinor, parental_consent_status: limitedMinor ? 'pending' : 'not_required', parent_guardian_email: limitedMinor ? address : null } }
        });
        if (!result.error && !result.data.session) {
          status.textContent = limitedMinor ? 'Signup started. The parent or legal guardian must complete the email confirmation/consent process before this account can use anything beyond the limited food features.' : 'Account created. Check your email to confirm your account, then log in.';
        } else if (!result.error) {
          const profilePayload = {
            date_of_birth: dob,
            terms_version: '1.0',
            privacy_version: '1.0',
            terms_accepted_at: new Date().toISOString(),
            privacy_accepted_at: new Date().toISOString(),
            parental_consent_required: limitedMinor,
            parental_consent_status: limitedMinor ? 'pending' : 'not_required',
            parent_guardian_email: limitedMinor ? address : null
          };
          await supabase.from('profiles').update(profilePayload).eq('id', result.data.user.id);
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

const PulsePlateApp = (() => {
  let supabase;
  let user;
  let selectedDate = new Date();
  let weekStart;
  let selectedFood = null;
  let searchTimer;
  let selectedFriendId = null;
  let selectedMealFriendId = null;
  let socialPeople = [];
  let socialConnections = [];
  let userMeals = [];
  let messagePollTimer;
  const sharedMealCollapsed = new Set();

  // Automatic macro calculation scaffold.
  // When the final nutrition factors are decided, only these values need to be
  // filled in for each goal. Leave them null to keep the current manual targets.
  // Formula: calories = weight * caloriesPerLb; protein = weight * proteinPerLb;
  // fat = weight * fatPerLb; carbs = (calories - protein*4 - fat*9) / 4.
  const AUTO_MACRO_FACTORS = {
    lose:     { caloriesPerLb: null, proteinPerLb: null, fatPerLb: null },
    maintain: { caloriesPerLb: null, proteinPerLb: null, fatPerLb: null },
    gain:     { caloriesPerLb: null, proteinPerLb: null, fatPerLb: null }
  };

  function calculateAutoMacroTargets(weight, goal) {
    const factors = AUTO_MACRO_FACTORS[goal];
    const w = Number(weight);
    if (!factors || !Number.isFinite(w) || w <= 0) return null;
    if (![factors.caloriesPerLb, factors.proteinPerLb, factors.fatPerLb].every(v => Number.isFinite(Number(v)))) return null;
    const calories = w * Number(factors.caloriesPerLb);
    const protein = w * Number(factors.proteinPerLb);
    const fat = w * Number(factors.fatPerLb);
    const carbs = Math.max((calories - protein * 4 - fat * 9) / 4, 0);
    return {
      calorie_goal: Math.round(calories),
      protein_goal: Math.round(protein * 10) / 10,
      fat_goal: Math.round(fat * 10) / 10,
      carbs_goal: Math.round(carbs * 10) / 10
    };
  }

  function autoMacroRulesConfigured(goal) {
    const factors = AUTO_MACRO_FACTORS[goal];
    return !!factors && [factors.caloriesPerLb, factors.proteinPerLb, factors.fatPerLb].every(v => Number.isFinite(Number(v)));
  }

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const dateKey = (date) => date.toISOString().slice(0, 10);
  const startOfWeek = (date) => {
    const d = new Date(date);
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  };
  const addDays = (date, amount) => { const d = new Date(date); d.setDate(d.getDate()+amount); return d; };
  const moneyless = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const formatDate = (date) => date.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  // Display names are intentionally stricter than ordinary messages.  Keep this
  // list focused on clearly abusive, sexual, or otherwise inappropriate terms.
  // The database trigger is the final enforcement layer; this provides instant UI feedback.
  // Local first-pass moderation. The database performs the authoritative check.
  // Text is normalized for case, accents, separators and common leetspeak so simple
  // obfuscation does not bypass the filter.
  const PROFANITY_TERMS = [
    'fuck','fucker','fucking','motherfucker','shit','shitty','bullshit','bitch','bitches',
    'asshole','dumbass','bastard','cunt','dick','dickhead','pussy','cock','slut','whore',
    'damn','hell','crap','piss','jackass','asshat','prick','twat','wanker'
  ];
  const HATE_TERMS = [
    'nigger','niggers','nigga','niggas','chink','chinks','spic','spics','kike','kikes',
    'gook','gooks','wetback','wetbacks','beaner','beaners','raghead','ragheads','coon','coons',
    'fag','fags','faggot','faggots','dyke','dykes','tranny','trannies'
  ];
  const SEXUAL_TERMS = ['porn','pornography','nude','nudes','naked','onlyfans','sexual services','sexually explicit','child sexual','minor sexual','sexting'];
  const LEET_MAP = { '@':'a','4':'a','3':'e','1':'i','!':'i','0':'o','$':'s','5':'s','7':'t','+':'t','8':'b'};
  function normalizeModerationText(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[0134578@$!+]/g, c => LEET_MAP[c] || c).replace(/[^a-z0-9]+/g,'');
  }
  function tokenModerationText(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[0134578@$!+]/g, c => LEET_MAP[c] || c).replace(/[^a-z0-9]+/g,' ').trim();
  }
  function containsTerm(text, terms) {
    const normalized=normalizeModerationText(text), tokens=tokenModerationText(text).split(/\s+/).filter(Boolean);
    return terms.some(term => tokens.includes(term) || normalized.includes(term));
  }
  const DOXXING_PATTERNS = [
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}\b/gi,
    /\b\d{1,5}\s+[A-Za-z0-9.'-]+\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|way|parkway|pkwy|place|pl)\b/gi,
    /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  ];
  function resetPatterns(){ DOXXING_PATTERNS.forEach(rx=>{rx.lastIndex=0;}); }
  function validateDisplayName(text) {
    const value=String(text||'').trim();
    if(!value) return 'Please enter a display name.';
    if(value.length>80) return 'Display names must be 80 characters or fewer.';
    if(containsTerm(value,PROFANITY_TERMS)||containsTerm(value,HATE_TERMS)||containsTerm(value,SEXUAL_TERMS)) return 'That display name contains language or content that is not allowed.';
    if(DOXXING_PATTERNS.some(rx=>rx.test(value))){resetPatterns();return 'Display names cannot contain contact or location information.';} resetPatterns(); return null;
  }
  function validateMessageText(text, isMinor=false) {
    const value=String(text||'').trim();
    if(!value) return 'Message cannot be empty.';
    if(value.length>4000) return 'Messages must be 4000 characters or fewer.';
    if(containsTerm(value,HATE_TERMS)) return 'This message contains hateful or discriminatory language and cannot be sent.';
    if(containsTerm(value,SEXUAL_TERMS)) return 'This message contains sexual or otherwise inappropriate content and cannot be sent.';
    if(isMinor && containsTerm(value,PROFANITY_TERMS)) return 'Profanity is not available for accounts under 18.';
    if(!isMinor && containsTerm(value,PROFANITY_TERMS)) return 'This message contains profanity that is not allowed on MacroSync.';
    if(DOXXING_PATTERNS.some(rx=>rx.test(value))){resetPatterns();return 'This message appears to contain personal information. Please remove IP addresses, home addresses, phone numbers, or email addresses.';} resetPatterns(); return null;
  }

  async function init() {
    try {
      supabase = await window.PulsePlate.ready;
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) { window.location.href = 'auth.html'; return; }
      user = data.session.user;
      weekStart = startOfWeek(selectedDate);
      const profile = await ensureProfile();
      await loadUserMeals();
      if (profile?.date_of_birth === null || profile?.date_of_birth === undefined) await requireAgeDeclaration();
      wireGlobalAuth();
      if (!profile?.onboarding_complete) {
        await showOnboarding(profile);
        return;
      }
      const moderationRequiresNameChange = await reviewMyContent().catch(error => { console.warn('Content moderation review unavailable:', error); return false; });
      if (moderationRequiresNameChange) return;
      await renderPage();
    } catch (error) {
      console.error(error);
      document.body.insertAdjacentHTML('afterbegin', `<div class="alpha-error">MacroSync could not initialize. ${escapeHtml(error.message)}</div>`);
    }
  }

  function ageInYears(dob) {
    const d=new Date(`${dob}T00:00:00`), now=new Date();
    let age=now.getFullYear()-d.getFullYear();
    const beforeBirthday=(now.getMonth()<d.getMonth()) || (now.getMonth()===d.getMonth() && now.getDate()<d.getDate());
    if(beforeBirthday) age--;
    return age;
  }
  async function requireAgeDeclaration() {
    const overlay=document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><p class="eyebrow">Age declaration required</p><h2>When were you born?</h2><p class="page-copy">MacroSync uses your date of birth only to apply age-appropriate content rules. It is an age declaration, not identity verification. Once saved, you cannot change it yourself.</p><form class="settings-stack" data-age-form><div class="field"><label for="declaredDob">Date of birth</label><input id="declaredDob" type="date" required max="${new Date().toISOString().slice(0,10)}"></div><button class="primary-button" type="submit">Save date of birth</button><p class="settings-status" data-age-status role="status"></p></form></section>`;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-age-form]').addEventListener('submit',async e=>{e.preventDefault();const status=overlay.querySelector('[data-age-status]');const dob=overlay.querySelector('#declaredDob').value;if(!dob){status.textContent='Enter your date of birth.';return;}const age=ageInYears(dob);if(age<13){status.textContent='MacroSync accounts are not available for users under 13.';return;}if(age>120){status.textContent='Please enter a valid date of birth.';return;}status.textContent='Saving…';const {error}=await supabase.from('profiles').update({date_of_birth:dob}).eq('id',user.id).is('date_of_birth',null);if(error){status.textContent=error.message;return;}overlay.remove();window.location.reload();});
  }

  async function ensureProfile() {
    const displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'MacroSync User';
    const { data: existing, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw error;
    if (!existing) {
      const { data: created, error: insertError } = await supabase.from('profiles').insert({ id: user.id, display_name: displayName, email: user.email || null, role: 'user', onboarding_complete: false }).select('*').single();
      if (insertError) throw insertError;
      return created;
    }
    if (existing.email !== (user.email || null)) {
      const { data: refreshed, error: refreshError } = await supabase.from('profiles').update({ email: user.email || null }).eq('id', user.id).select('*').single();
      if (!refreshError) return refreshed;
    }
    return existing;
  }

  async function showOnboarding(profile) {
    const existingGoals = await getGoals();
    const overlay = document.createElement('div');
    overlay.className = 'onboarding-overlay';
    overlay.innerHTML = `
      <section class="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
        <div class="onboarding-progress"><span></span></div>
        <p class="eyebrow">First-time setup</p>
        <h1 id="onboardingTitle">Welcome to MacroSync</h1>
        <p class="page-copy">Let's personalize your dashboard. You can change these choices later from Goals and Account.</p>
        <form id="onboardingForm">
          <div class="onboarding-section">
            <h2>What is your main goal?</h2>
            <div class="goal-choice-grid">
              ${[['lose','Lose weight'],['maintain','Maintain my weight'],['gain','Build muscle / gain weight'],['health','General health'],['custom','Something else']].map(([v,l])=>`<label class="choice-card"><input type="radio" name="primaryGoal" value="${v}" ${profile?.primary_goal===v?'checked':''}><span>${l}</span></label>`).join('')}
            </div>
          </div>
          <div class="onboarding-grid">
            <div class="field"><label for="onboardCurrentWeight">Current weight <span>(optional)</span></label><input id="onboardCurrentWeight" type="number" min="0" step="0.1" value="${profile?.current_weight ?? existingGoals.current_weight ?? ''}" placeholder="Optional"></div>
            <div class="field"><label for="onboardGoalWeight">Goal weight <span>(optional)</span></label><input id="onboardGoalWeight" type="number" min="0" step="0.1" value="${profile?.goal_weight ?? existingGoals.goal_weight ?? ''}" placeholder="Optional"></div>
          </div>
          <div class="onboarding-section">
            <h2>Daily nutrition targets</h2>
            <p class="page-copy">These are starting targets. You can change them later.</p>
            <div class="onboarding-grid onboarding-grid-four">
              <div class="field"><label for="onboardCalories">Calories</label><input id="onboardCalories" type="number" min="500" max="10000" required value="${existingGoals.calorie_goal}"></div>
              <div class="field"><label for="onboardProtein">Protein (g)</label><input id="onboardProtein" type="number" min="0" max="1000" required value="${existingGoals.protein_goal}"></div>
              <div class="field"><label for="onboardCarbs">Carbs (g)</label><input id="onboardCarbs" type="number" min="0" max="1500" required value="${existingGoals.carbs_goal}"></div>
              <div class="field"><label for="onboardFat">Fat (g)</label><input id="onboardFat" type="number" min="0" max="500" required value="${existingGoals.fat_goal}"></div>
            </div>
          </div>
          <div class="onboarding-section">
            <h2>Are you a personal trainer?</h2>
            <div class="role-choice-grid">
              <label class="choice-card"><input type="radio" name="role" value="user" checked><span>No, I'm using MacroSync for myself</span></label>
              <label class="choice-card"><input type="radio" name="role" value="trainer"><span>Yes, I'm a personal trainer</span></label>
            </div>
            <div class="field trainer-business-field" id="trainerBusinessField" hidden><label for="onboardBusiness">Business / gym / organization <span>(optional)</span></label><input id="onboardBusiness" maxlength="120" placeholder="Leave blank if independent"></div>
          </div>
          <p class="onboarding-status" id="onboardingStatus" role="status"></p>
          <button class="primary-button" type="submit">Finish setup</button>
        </form>
      </section>`;
    document.body.appendChild(overlay);
    const business = overlay.querySelector('#trainerBusinessField');
    const syncRole = () => { business.hidden = overlay.querySelector('input[name="role"]:checked')?.value !== 'trainer'; };
    overlay.querySelectorAll('input[name="role"]').forEach(input => input.addEventListener('change', syncRole));
    syncRole();
    overlay.querySelector('#onboardingForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = overlay.querySelector('#onboardingStatus');
      status.textContent = 'Saving your setup…';
      const primaryGoal = overlay.querySelector('input[name="primaryGoal"]:checked')?.value || 'health';
      const role = overlay.querySelector('input[name="role"]:checked')?.value || 'user';
      const profilePayload = { id:user.id, display_name:profile?.display_name || user.user_metadata?.display_name || user.email?.split('@')[0] || 'MacroSync User', role, business_name:role==='trainer' ? overlay.querySelector('#onboardBusiness').value.trim() || null : null, primary_goal:primaryGoal, onboarding_complete:true };
      const goalsPayload = { user_id:user.id, calorie_goal:Number(overlay.querySelector('#onboardCalories').value), protein_goal:Number(overlay.querySelector('#onboardProtein').value), carbs_goal:Number(overlay.querySelector('#onboardCarbs').value), fat_goal:Number(overlay.querySelector('#onboardFat').value), current_weight:Number(overlay.querySelector('#onboardCurrentWeight').value)||null, goal_weight:Number(overlay.querySelector('#onboardGoalWeight').value)||null };
      const { error: profileError } = await supabase.from('profiles').upsert(profilePayload);
      if (profileError) { status.textContent=profileError.message; return; }
      const { error: goalError } = await supabase.from('nutrition_goals').upsert(goalsPayload);
      if (goalError) { status.textContent=goalError.message; return; }
      overlay.remove();
      await renderPage();
    });
  }

  function wireGlobalAuth() {
    const topbar = $('.topbar');
    if (!topbar || $('#alphaSettingsMenu')) return;

    const bar = document.createElement('div');
    bar.id = 'alphaAccountBar';
    bar.className = 'alpha-account-bar';
    bar.innerHTML = `
      <span class="alpha-account-email">${escapeHtml(user.email || '')}</span>
      <div class="settings-menu-wrap">
        <button class="settings-burger" id="settingsBurger" type="button" aria-label="Open settings menu" aria-expanded="false">
          <span></span><span></span><span></span>
          <span class="notification-badge" data-notification-badge hidden>0</span>
        </button>
        <div class="settings-menu" id="alphaSettingsMenu" hidden>
          <div class="settings-menu-title">MacroSync</div>
          <a href="index.html">Dashboard</a>
          <a href="settings.html">Settings</a>
          <button type="button" data-notifications>Notifications <span class="menu-badge" data-menu-notification-count hidden>0</span></button>
          <button type="button" data-message-notification-settings>Message notifications <span data-message-notification-state>On</span></button>
          <button type="button" data-theme-toggle>Light mode</button>
          <button type="button" data-enable-browser-notifications>Enable browser notifications</button>
          <button type="button" data-logout>Log out</button>
        </div>
      </div>`;
    topbar.appendChild(bar);

    const burger = $('#settingsBurger');
    const menu = $('#alphaSettingsMenu');
    const closeMenu = () => { menu.hidden = true; burger.setAttribute('aria-expanded', 'false'); };
    burger.addEventListener('click', (event) => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      burger.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', (event) => {
      if (!bar.contains(event.target)) closeMenu();
    });
    $('[data-theme-toggle]')?.addEventListener('click', () => {
      const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
      localStorage.setItem('macrosync-theme', next);
      localStorage.setItem('pulseplate-theme', next);
      applyTheme();
    });
    $('[data-notifications]')?.addEventListener('click', () => { closeMenu(); showNotificationsModal(); });
    $('[data-message-notification-settings]')?.addEventListener('click', () => { closeMenu(); showMessageNotificationSettingsModal(); });
    $('[data-enable-browser-notifications]')?.addEventListener('click', async () => {
      closeMenu();
      const messageNotificationsEnabled = await getMessageNotificationSetting().catch(() => true);
      if (!messageNotificationsEnabled) { alert('Message notifications are turned off in MacroSync settings. Turn them on first to enable browser notifications.'); return; }
      if (!('Notification' in window)) { alert('This browser does not support browser notifications.'); return; }
      const permission = await Notification.requestPermission();
      if (permission === 'granted') new Notification('MacroSync notifications enabled', { body: 'You will be notified when new messages arrive while MacroSync is open.' });
    });
    applyTheme();
    refreshNotifications().catch(console.error);
    refreshMessageNotificationSetting().catch(console.error);
    if (!window.__macroSyncNotificationTimer) {
      window.__macroSyncNotificationTimer = setInterval(() => refreshNotifications().catch(console.error), 4000);
    }
    $('[data-logout]')?.addEventListener('click', async () => {
      closeMenu();
      await supabase.auth.signOut();
      window.location.href='auth.html';
    });
  }

  function applyTheme() {
    const theme = localStorage.getItem('macrosync-theme') || localStorage.getItem('pulseplate-theme') || 'dark';
    localStorage.setItem('macrosync-theme', theme);
    document.body.classList.toggle('light-theme', theme === 'light');
    $$('[data-theme-toggle]').forEach(button => { button.textContent = theme === 'light' ? 'Dark mode' : 'Light mode'; });
  }

  async function getMessageNotificationSetting() {
    const { data, error } = await supabase.from('profiles').select('message_notifications_enabled').eq('id', user.id).single();
    if (error) {
      if (/message_notifications_enabled/i.test(error.message || '')) return true;
      throw error;
    }
    return data?.message_notifications_enabled !== false;
  }

  async function refreshMessageNotificationSetting() {
    if (!supabase || !user) return;
    const enabled = await getMessageNotificationSetting();
    const state = $('[data-message-notification-state]');
    if (state) state.textContent = enabled ? 'On' : 'Off';
  }

  async function getUnreadNotifications() {
    const { data, error } = await supabase.from('notifications').select('*').eq('recipient_id', user.id).is('read_at', null).order('created_at', { ascending: false }).limit(25);
    if (error) {
      // Older databases may not have the notifications table yet. Keep the app usable until schema is applied.
      if (/notifications/i.test(error.message || '')) return [];
      throw error;
    }
    return data || [];
  }

  async function refreshNotifications() {
    if (!supabase || !user) return;
    const messageNotificationsEnabled = await getMessageNotificationSetting().catch(() => true);
    if (!messageNotificationsEnabled) {
      const badge = $('[data-notification-badge]');
      const menuCount = $('[data-menu-notification-count]');
      if (badge) badge.hidden = true;
      if (menuCount) menuCount.hidden = true;
      return;
    }
    const notifications = await getUnreadNotifications();
    const count = notifications.length;
    const badge = $('[data-notification-badge]');
    const menuCount = $('[data-menu-notification-count]');
    if (badge) { badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = count === 0; }
    if (menuCount) { menuCount.textContent = count > 99 ? '99+' : String(count); menuCount.hidden = count === 0; }
    const previous = Number(window.__macroSyncLastUnreadCount || 0);
    window.__macroSyncLastUnreadCount = count;
    if (count > previous && previous >= 0 && 'Notification' in window && Notification.permission === 'granted') {
      const latest = notifications[0];
      if (latest && latest.id !== window.__macroSyncLastNotificationId) {
        window.__macroSyncLastNotificationId = latest.id;
        new Notification(latest.title || 'New MacroSync message', { body: latest.body || 'You have a new notification.' });
      }
    }
  }

  async function showMessageNotificationSettingsModal() {
    const enabled = await getMessageNotificationSetting().catch(() => true);
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML = `
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="messageNotificationSettingsTitle">
        <div class="modal-header"><div><p class="eyebrow">Notification settings</p><h2 id="messageNotificationSettingsTitle">Message notifications</h2></div><button type="button" class="icon-button" data-close-settings>×</button></div>
        <label class="toggle-row notification-setting-row"><input type="checkbox" data-message-notifications-toggle ${enabled ? 'checked' : ''}><span><strong>Notify me when I receive a message</strong><small>Turn this off if you do not want MacroSync to create notifications for new messages sent to you.</small></span></label>
        <p class="settings-status" data-message-notification-status role="status"></p>
        <div class="modal-actions"><button class="primary-button" type="button" data-close-settings>Done</button></div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close-settings]').forEach(b => b.onclick = () => overlay.remove());
    overlay.querySelector('[data-message-notifications-toggle')?.addEventListener('change', async event => {
      const toggle = event.target;
      const status = overlay.querySelector('[data-message-notification-status]');
      toggle.disabled = true;
      status.textContent = 'Saving…';
      const { error } = await supabase.from('profiles').update({ message_notifications_enabled: toggle.checked }).eq('id', user.id);
      toggle.disabled = false;
      if (error) {
        toggle.checked = !toggle.checked;
        status.textContent = error.message;
        return;
      }
      status.textContent = toggle.checked ? 'Message notifications are enabled.' : 'Message notifications are disabled.';
      const state = $('[data-message-notification-state]');
      if (state) state.textContent = toggle.checked ? 'On' : 'Off';
      if (!toggle.checked) {
        window.__macroSyncLastUnreadCount = 0;
        window.__macroSyncLastNotificationId = null;
      }
    });
  }

  async function showNotificationsModal() {
    const notifications = await getUnreadNotifications().catch(error => { alert(error.message); return []; });
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML = `
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="notificationsTitle">
        <div class="modal-header"><div><p class="eyebrow">Notifications</p><h2 id="notificationsTitle">Your notifications</h2></div><button type="button" class="icon-button" data-close-settings>×</button></div>
        <div class="notification-list">${notifications.length ? notifications.map(n => `<article class="notification-card"><strong>${escapeHtml(n.title || 'Notification')}</strong><p>${escapeHtml(n.body || '')}</p><small>${new Date(n.created_at).toLocaleString()}</small></article>`).join('') : '<p class="page-copy">You have no unread notifications.</p>'}</div>
        <div class="modal-actions"><button class="ghost-button" type="button" data-mark-notifications-read ${notifications.length ? '' : 'disabled'}>Mark all as read</button><button class="primary-button" type="button" data-close-settings>Close</button></div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close-settings]').forEach(b => b.onclick = () => overlay.remove());
    overlay.querySelector('[data-mark-notifications-read')?.addEventListener('click', async () => {
      const { error } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_id', user.id).is('read_at', null);
      if (error) { alert(error.message); return; }
      overlay.remove();
      await refreshNotifications();
    });
  }

  function showEmailChangeModal() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML = `
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="emailTitle">
        <div class="modal-header"><div><p class="eyebrow">Account settings</p><h2 id="emailTitle">Change email</h2></div><button type="button" class="icon-button" data-close-settings>×</button></div>
        <p class="page-copy">Enter a new email address. Supabase may require you to confirm the change from your email inbox.</p>
        <form data-email-form>
          <div class="field"><label for="newEmail">New email</label><input id="newEmail" type="email" required value="${escapeHtml(user.email || '')}"></div>
          <p class="settings-status" data-email-status role="status"></p>
          <div class="modal-actions"><button class="ghost-button" type="button" data-close-settings>Cancel</button><button class="primary-button" type="submit">Update email</button></div>
        </form>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close-settings]').forEach(b => b.onclick = () => overlay.remove());
    overlay.querySelector('[data-email-form]').addEventListener('submit', async event => {
      event.preventDefault();
      const status = overlay.querySelector('[data-email-status]');
      const newEmail = overlay.querySelector('#newEmail').value.trim();
      if (!newEmail) return;
      status.textContent = 'Updating email…';
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) { status.textContent = error.message; return; }
      await supabase.from('profiles').update({ email: newEmail }).eq('id', user.id);
      status.textContent = 'Email update requested. Check your inbox for any confirmation links.';
      user.email = newEmail;
      setTimeout(() => overlay.remove(), 1800);
    });
  }

  async function renderPage() {
    const page = document.body.dataset.page || location.pathname.split('/').pop().replace('.html','');
    if (page === 'dashboard' || page === 'index') await renderDashboard();
    if (page === 'log') await renderFoodLogger();
    if (page === 'account') await renderAccount();
    if (page === 'settings') await renderSettings();
    if (page === 'goals') await renderGoals();
    if (page === 'progress') await renderProgress();
    if (page === 'recipes') await renderRecipes();
    if (page === 'social') await renderSocial();
    if (page === 'admin') await renderAdmin();
    wireDateControls();
  }

  async function reviewMyContent() {
    if (!supabase || !user) return false;
    const { data, error } = await supabase.rpc('review_my_content');
    if (error) { console.warn(error); return false; }
    const openFlags = (data || []).filter(f => f.status === 'open');
    const nameFlag = openFlags.find(f => f.content_type === 'display_name');

    if (nameFlag) {
      await showMandatoryDisplayNameChange(nameFlag.reason);
      return true;
    }

    if (!openFlags.length) return false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card moderation-notice" role="dialog" aria-modal="true" aria-labelledby="moderationNoticeTitle"><p class="eyebrow">Action required</p><h2 id="moderationNoticeTitle">Some of your messages need attention</h2><p class="page-copy">MacroSync found messages that may violate its rules. You can delete the flagged messages below.</p><div class="moderation-items">${openFlags.map(f => `<div class="moderation-item" data-moderation-flag="${f.id}"><strong>Message</strong><p>${escapeHtml(f.reason)}</p><div class="modal-actions"><button type="button" class="ghost-button danger-button" data-delete-flagged-message="${f.content_id}">Delete message</button></div></div>`).join('')}</div><div class="modal-actions"><button type="button" class="primary-button" data-close-moderation>Review later</button></div></section>`;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-close-moderation]')?.addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('[data-delete-flagged-message]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this message permanently?')) return;
      const flag = btn.closest('[data-moderation-flag]');
      const { data: deleted, error: delError } = await supabase.rpc('delete_message', { p_message_id: Number(btn.dataset.deleteFlaggedMessage) });
      if (delError) { alert(delError.message); return; }
      if (!deleted) { alert('The message could not be deleted.'); return; }
      await supabase.from('moderation_flags').update({ status:'resolved', resolved_at:new Date().toISOString() }).eq('id', flag.dataset.moderationFlag).eq('user_id', user.id);
      flag.remove();
      if (!overlay.querySelector('[data-moderation-flag]')) overlay.remove();
    }));
    return false;
  }

  async function showMandatoryDisplayNameChange(reason) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card moderation-notice" role="dialog" aria-modal="true" aria-labelledby="requiredNameTitle"><p class="eyebrow">Action required</p><h2 id="requiredNameTitle">Your display name must be changed</h2><p class="page-copy">Your current display name does not meet MacroSync's content rules. You must choose a new display name before you can continue using the app.</p><p class="settings-status">${escapeHtml(reason || 'Your display name contains language or content that is not allowed.')}</p><form class="settings-stack" data-required-name-form><div class="field"><label for="requiredDisplayName">New display name</label><input id="requiredDisplayName" maxlength="80" autocomplete="nickname" required autofocus /></div><button class="primary-button" type="submit">Change display name</button><p class="settings-status" data-required-name-status role="status"></p></form></section>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('[data-required-name-form]');
    const input = overlay.querySelector('#requiredDisplayName');
    const status = overlay.querySelector('[data-required-name-status]');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const displayName = input.value.trim();
      const validation = validateDisplayName(displayName);
      if (validation) { status.textContent = validation; return; }
      status.textContent = 'Saving…';
      const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
      if (error) { status.textContent = error.message; return; }
      const { error: authError } = await supabase.auth.updateUser({ data: { display_name: displayName } });
      if (authError) { status.textContent = authError.message; return; }
      await supabase.from('moderation_flags').update({ status:'resolved', resolved_at:new Date().toISOString() }).eq('user_id', user.id).eq('content_type','display_name').eq('status','open');
      overlay.remove();
      window.location.reload();
    });
  }

  async function getGoals() {
    const { data } = await supabase.from('nutrition_goals').select('*').eq('user_id', user.id).maybeSingle();
    return data || { calorie_goal:2050, protein_goal:147, carbs_goal:230, fat_goal:68, current_weight:null, goal_weight:null };
  }

  async function getEntries(date = selectedDate) {
    const { data, error } = await supabase.from('food_entries').select('*').eq('user_id', user.id).eq('logged_date', dateKey(date)).order('created_at');
    if (error) throw error;
    return data || [];
  }

  async function loadUserMeals() {
    // Prefer the table directly so the meal UI still works if the RPC is missing
    // from an older database or Supabase's function cache has not refreshed yet.
    let { data, error } = await supabase
      .from('meals')
      .select('id,user_id,meal_number,name,created_at')
      .eq('user_id', user.id)
      .order('meal_number', { ascending: true });

    if (error) throw error;

    // Existing accounts may have an empty meals table. Create the required
    // starting meals directly under the user's RLS policy.
    if (!data || data.length === 0) {
      const defaults = [1, 2, 3].map(n => ({
        user_id: user.id,
        meal_number: n,
        name: `Meal ${n}`,
        sort_order: n
      }));
      const { data: created, error: createError } = await supabase
        .from('meals')
        .insert(defaults)
        .select('id,user_id,meal_number,name,sort_order,created_at');
      if (createError) throw createError;
      data = created || [];
    }

    userMeals = data.sort((a, b) => Number(a.meal_number) - Number(b.meal_number));
    return userMeals;
  }

  function mealOptionsMarkup(selected = '') {
    return userMeals.map(meal => `<option value="${escapeHtml(meal.name)}" ${meal.name === selected ? 'selected' : ''}>${escapeHtml(meal.name)}</option>`).join('');
  }

  async function refreshMealUI() {
    await loadUserMeals();
    await renderSelectedDateEntries();
    await renderMealManager();
  }

  async function openRenameMealModal(meal) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="renameMealTitle">
      <button class="modal-close" data-close type="button" aria-label="Close">×</button>
      <p class="eyebrow">Meal ${Number(meal.meal_number)}</p><h2 id="renameMealTitle">Rename meal</h2>
      <p class="page-copy">Rename this meal without losing any foods already logged under it.</p>
      <div class="field"><label for="renameMealInput">Meal name</label><input id="renameMealInput" maxlength="40" value="${escapeHtml(meal.name)}" autocomplete="off"></div>
      <p class="save-status" data-meal-status role="status"></p>
      <div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-rename type="button">Save name</button></div>
    </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close]').forEach(b => b.onclick = () => overlay.remove());
    const input = overlay.querySelector('#renameMealInput'); input.focus(); input.select();
    overlay.querySelector('[data-save-rename]').onclick = async () => {
      const name = input.value.trim();
      const status = overlay.querySelector('[data-meal-status]');
      if (!name) { status.textContent = 'Enter a meal name.'; return; }
      status.textContent = 'Saving…';
      const { error } = await supabase.rpc('rename_meal', { p_meal_id: meal.id, p_name: name });
      if (error) { status.textContent = error.message; return; }
      overlay.remove();
      await refreshMealUI();
    };
  }

  async function openAddMealModal() {
    if (userMeals.length >= 10) { alert('You can have up to 10 meals.'); return; }
    const nextNumber = Math.max(0, ...userMeals.map(m => Number(m.meal_number))) + 1;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="addMealTitle">
      <button class="modal-close" data-close type="button" aria-label="Close">×</button>
      <p class="eyebrow">Meal ${nextNumber}</p><h2 id="addMealTitle">Add a meal</h2>
      <p class="page-copy">New meals start with a numbered name, and you can rename them whenever you want.</p>
      <div class="field"><label for="newMealInput">Meal name</label><input id="newMealInput" maxlength="40" value="Meal ${nextNumber}" autocomplete="off"></div>
      <p class="save-status" data-meal-status role="status"></p>
      <div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-add type="button">Add meal</button></div>
    </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close]').forEach(b => b.onclick = () => overlay.remove());
    const input = overlay.querySelector('#newMealInput'); input.focus(); input.select();
    overlay.querySelector('[data-save-add]').onclick = async () => {
      const name = input.value.trim();
      const status = overlay.querySelector('[data-meal-status]');
      if (!name) { status.textContent = 'Enter a meal name.'; return; }
      status.textContent = 'Adding…';
      const { error } = await supabase.rpc('add_meal', { p_name: name });
      if (error) { status.textContent = error.message; return; }
      overlay.remove();
      await refreshMealUI();
    };
  }

  async function renderMealManager() {
    const box = $('[data-meal-manager]'); if (!box) return;
    box.innerHTML = `<div class="meal-manager-list">${userMeals.map(meal => `<div class="meal-manager-row"><div><strong>${escapeHtml(meal.name)}</strong><small>Meal ${Number(meal.meal_number)}</small></div><button class="ghost-button" type="button" data-rename-meal="${meal.id}">Rename</button></div>`).join('')}</div>
      <button class="primary-button meal-manager-add" type="button" data-add-meal ${userMeals.length >= 10 ? 'disabled' : ''}>+ Add meal${userMeals.length >= 10 ? ' (10 max)' : ''}</button>`;
    box.querySelectorAll('[data-rename-meal]').forEach(button => button.onclick = () => {
      const meal = userMeals.find(m => String(m.id) === button.dataset.renameMeal);
      if (meal) openRenameMealModal(meal);
    });
    box.querySelector('[data-add-meal]')?.addEventListener('click', openAddMealModal);
  }

  async function renderDashboard() {
    const [goals, entries] = await Promise.all([getGoals(), getEntries()]);
    const totals = totalsFor(entries);
    setText('[data-date-label]', formatDate(selectedDate));
    setText('[data-cal-left]', Math.max(goals.calorie_goal - totals.calories, 0).toLocaleString());
    setText('[data-cal-eaten]', totals.calories.toLocaleString());
    setText('[data-cal-goal]', goals.calorie_goal.toLocaleString());
    setText('[data-percent]', `${Math.round((totals.calories / Math.max(goals.calorie_goal,1))*100)}%`);
    setText('[data-day-summary]', entries.length ? `${entries.length} food item${entries.length===1?'':'s'} logged today.` : 'No foods logged yet. Add your first meal to start your diary.');
    setText('#coachNote', entries.length ? 'Keep building your day with foods that fit your targets.' : 'Search the food database to add your first meal.');
    setText('[data-water]', '— cups');
    setText('[data-steps]', '— steps');
    setText('[data-protein-text]', `${moneyless(totals.protein)} / ${moneyless(goals.protein_goal)}g`);
    setText('[data-carbs-text]', `${moneyless(totals.carbs)} / ${moneyless(goals.carbs_goal)}g`);
    setText('[data-fat-text]', `${moneyless(totals.fat)} / ${moneyless(goals.fat_goal)}g`);
    setText('[data-dashboard-cal-goal]', goals.calorie_goal.toLocaleString());
    setText('[data-dashboard-protein-goal]', `${moneyless(goals.protein_goal)}g`);
    setWidth('[data-goal-progress]', totals.calories/goals.calorie_goal*100);
    setWidth('[data-protein-bar]', totals.protein/goals.protein_goal*100);
    setWidth('[data-carbs-bar]', totals.carbs/goals.carbs_goal*100);
    setWidth('[data-fat-bar]', totals.fat/goals.fat_goal*100);
    $$('.ring-fill').forEach(r => r.style.setProperty('--ring-offset', 352 - Math.min(totals.calories/goals.calorie_goal,1)*352));
    await renderMeals(entries);
    await renderMealManager();
    await renderLastUsedMeal();
    renderCalendar();
  }

  function totalsFor(entries) { return entries.reduce((t,e)=>({calories:t.calories+Number(e.calories||0),protein:t.protein+Number(e.protein||0),carbs:t.carbs+Number(e.carbs||0),fat:t.fat+Number(e.fat||0)}),{calories:0,protein:0,carbs:0,fat:0}); }

  const mealCollapsed = new Set();

  async function renderMeals(entries) {
    const list = $('[data-meal-list]'); if (!list) return;
    const grouped = userMeals.map(meal => ({ meal: meal.name, mealId: meal.id, mealNumber: meal.meal_number, items: entries.filter(e => e.meal === meal.name) }));
    list.innerHTML = grouped.map(group => {
      const calories = group.items.reduce((sum, e) => sum + Number(e.calories || 0), 0);
      const stateKey = `${dateKey(selectedDate)}:${group.mealId}`;
      const isOpen = !mealCollapsed.has(stateKey);
      return `<details class="meal-group" data-meal-state-key="${stateKey}" ${isOpen ? 'open' : ''}>
        <summary class="meal-group-header">
          <span class="meal-group-title"><span class="meal-chevron" aria-hidden="true">›</span><span><strong>${group.meal}</strong><small>${group.items.length ? `${group.items.length} item${group.items.length === 1 ? '' : 's'}` : 'No foods logged'}</small></span></span>
          <span class="meal-group-total">${moneyless(calories)} cal</span>
        </summary>
        <div class="meal-group-body">
          ${group.items.length ? group.items.map(e => `<article class="meal-item">
            <div class="meal-item-main"><strong>${escapeHtml(e.food_name)}</strong><span>${escapeHtml(e.serving)}</span></div>
            <div class="meal-item-nutrition"><strong>${moneyless(e.calories)} cal</strong><span>P ${moneyless(e.protein)}g</span><span>C ${moneyless(e.carbs)}g</span><span>F ${moneyless(e.fat)}g</span></div>
            <div class="meal-item-actions"><button class="text-button" type="button" data-edit-entry="${e.id}">Edit</button><button class="text-button danger-button" type="button" data-delete-entry="${e.id}">Delete</button><button class="text-button" type="button" data-move-entry="${e.id}">Move</button></div>
          </article>`).join('') : '<p class="meal-empty-copy">No foods logged yet.</p>'}
          <div class="meal-group-actions"><a class="meal-add-link" href="log_food.html">+ Add to ${group.meal}</a>${group.items.length ? `<button class="text-button" type="button" data-save-current-meal="${group.meal}">Save this meal</button>` : ''}</div>
        </div>
      </details>`;
    }).join('');
    list.querySelectorAll('[data-meal-state-key]').forEach(details => details.addEventListener('toggle', () => {
      const key = details.dataset.mealStateKey;
      if (details.open) mealCollapsed.delete(key); else mealCollapsed.add(key);
    }));
    list.querySelectorAll('[data-save-current-meal]').forEach(button => button.addEventListener('click', () => saveCurrentMealAsSaved(button.dataset.saveCurrentMeal)));
    list.querySelectorAll('[data-edit-entry]').forEach(button => button.addEventListener('click', () => { const entry = entries.find(e => String(e.id) === button.dataset.editEntry); if (entry) openEditEntryModal(entry); }));
    list.querySelectorAll('[data-delete-entry]').forEach(button => button.addEventListener('click', async () => {
      if (!confirm('Delete this food entry permanently?')) return;
      const { error } = await supabase.from('food_entries').delete().eq('id', button.dataset.deleteEntry).eq('user_id', user.id);
      if (error) return alert(error.message);
      await renderPage();
    }));
    list.querySelectorAll('[data-move-entry]').forEach(button => button.addEventListener('click', () => { const entry = entries.find(e => String(e.id) === button.dataset.moveEntry); if (entry) openMoveEntryModal(entry); }));
  }

  function parseServingAmount(serving) {
    const match = String(serving || '').match(/[-+]?\d*\.?\d+/);
    return match ? Number(match[0]) : null;
  }

  async function openEditEntryModal(entry) {
    const oldAmount = parseServingAmount(entry.serving) || 1;
    const unitMatch = String(entry.serving || '').match(/[-+]?\d*\.?\d+\s*(.*)$/);
    const unit = unitMatch?.[1]?.trim() || 'serving';
    const overlay = document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Edit food</p><h2>${escapeHtml(entry.food_name)}</h2><p class="page-copy">Changing the amount scales the logged nutrition values proportionally.</p><div class="field"><label for="editEntryAmount">Amount</label><input id="editEntryAmount" type="number" min="0.01" step="0.01" value="${oldAmount}"></div><div class="field"><label for="editEntryUnit">Unit</label><input id="editEntryUnit" value="${escapeHtml(unit)}" maxlength="40"></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-edit type="button">Save changes</button></div></section>`;
    document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-save-edit]').onclick=async()=>{
      const amount=Number(overlay.querySelector('#editEntryAmount').value); const newUnit=overlay.querySelector('#editEntryUnit').value.trim() || 'serving';
      if(!Number.isFinite(amount)||amount<=0)return alert('Enter a valid amount.');
      const factor=oldAmount>0?amount/oldAmount:1;
      const payload={serving:`${moneyless(amount)} ${newUnit}`,calories:Number(entry.calories||0)*factor,protein:Number(entry.protein||0)*factor,carbs:Number(entry.carbs||0)*factor,fat:Number(entry.fat||0)*factor};
      const {error}=await supabase.from('food_entries').update(payload).eq('id',entry.id).eq('user_id',user.id); if(error)return alert(error.message);
      overlay.remove(); await renderPage();
    };
  }

  function openMoveEntryModal(entry) {
    const overlay=document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Move food</p><h2>${escapeHtml(entry.food_name)}</h2><div class="field"><label for="moveEntryMeal">Move to meal</label><select id="moveEntryMeal">${mealOptionsMarkup(entry.meal)}</select></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-move type="button">Move food</button></div></section>`;
    document.body.appendChild(overlay); overlay.querySelector('#moveEntryMeal').value=entry.meal; overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-save-move]').onclick=async()=>{const meal=overlay.querySelector('#moveEntryMeal').value;if(meal===entry.meal){overlay.remove();return;}const {error}=await supabase.from('food_entries').update({meal}).eq('id',entry.id).eq('user_id',user.id);if(error)return alert(error.message);overlay.remove();await renderPage();};
  }

  async function getLastUsedMeal() {
    const {data,error}=await supabase.from('food_entries').select('*').eq('user_id',user.id).order('created_at',{ascending:false}).limit(100);
    if(error) throw error;
    const rows=data||[]; if(!rows.length)return null;
    const latest=rows[0];
    const items=rows.filter(r=>r.logged_date===latest.logged_date && r.meal===latest.meal).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    return {date:latest.logged_date,meal:latest.meal,items};
  }

  async function renderLastUsedMeal() {
    const box=$('[data-last-used-meal]'); if(!box)return;
    try {
      const meal=await getLastUsedMeal();
      if(!meal||!meal.items.length){box.innerHTML='<p class="page-copy">No previous meal yet.</p>';return;}
      const totals=totalsFor(meal.items);
      box.innerHTML=`<button class="last-used-meal-card" type="button" data-add-last-used-meal><div><p class="eyebrow">${escapeHtml(meal.meal)}</p><h3>Last used meal</h3><span>${meal.items.length} item${meal.items.length===1?'':'s'} · ${moneyless(totals.calories)} cal</span></div><strong>Add</strong></button>`;
      box.querySelector('[data-add-last-used-meal]').onclick=async()=>{
        const payload=meal.items.map(item=>({user_id:user.id,logged_date:dateKey(selectedDate),meal:item.meal,food_name:item.food_name,serving:item.serving,fdc_id:item.fdc_id,calories:item.calories,protein:item.protein,carbs:item.carbs,fat:item.fat}));
        const {error}=await supabase.from('food_entries').insert(payload); if(error)return alert(error.message); await renderPage();
      };
    } catch(error) { box.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`; }
  }

  async function renderFoodLogger() {
    renderCalendar();
    const search = $('[data-food-search]');
    const list = $('[data-food-database-list]');
    if (!search || !list) return;

    await renderPersonalFoods();
    await renderMealManager();
    let foodSource = 'usda';
    const sourceButtons = $$('[data-food-source]');
    const sourceHint = $('[data-food-source-hint]');
    const setFoodSource = async source => {
      foodSource = source;
      sourceButtons.forEach(b => b.classList.toggle('active', b.dataset.foodSource === source));
      if (sourceHint) sourceHint.textContent = source === 'usda' ? 'USDA FoodData Central results with nutrition verification.' : source === 'community' ? 'Foods published by MacroSync users. These are community-provided, not USDA verified.' : 'Foods you created privately for your own account.';
      await runFoodSearch();
    };
    sourceButtons.forEach(b => b.addEventListener('click', () => setFoodSource(b.dataset.foodSource)));
    const runFoodSearch = async () => {
      const q = search.value.trim();
      if (foodSource === 'personal') { await renderPersonalFoods(); return; }
      if (q.length < 2) {
        list.innerHTML = `<p class="page-copy">${foodSource === 'usda' ? 'Type at least two characters to search USDA FoodData Central.' : 'Type at least two characters to search community foods.'}</p>`;
        return;
      }
      list.innerHTML = `<p class="page-copy">Searching ${foodSource === 'usda' ? 'USDA FoodData Central' : 'community foods'}…</p>`;
      try {
        if (foodSource === 'community') {
          await renderCommunityFoods(q);
          return;
        }
        const response = await fetch(`/api/foods/search?q=${encodeURIComponent(q)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Food search failed.');
        const foods = Array.isArray(data.foods) ? data.foods : [];
        const rejectedNotice = Number(data.verification?.rejectedInvalidRecords || 0) > 0 ? `<p class="save-status">${Number(data.verification.rejectedInvalidRecords)} USDA result${Number(data.verification.rejectedInvalidRecords) === 1 ? '' : 's'} were hidden because their macro values failed basic physical consistency checks.</p>` : '';
        list.innerHTML = foods.length ? `${rejectedNotice}<p class="food-search-count">Showing ${foods.length} result${foods.length === 1 ? '' : 's'}${data.totalHits ? ` of ${Number(data.totalHits).toLocaleString()}` : ''}.</p>${foods.map(foodCard).join('')}` : `${rejectedNotice}<p class="page-copy">No matching USDA foods found.</p>`;
        $$('.food-db-card').forEach(card => card.addEventListener('click', () => { const food = foods.find(f => String(f.id) === card.dataset.id); if (food) openServingModal(food, 'usda'); }));
      } catch (error) { console.error(error); list.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; }
    };
    search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runFoodSearch, 350); };
    $('[data-manual-toggle]')?.addEventListener('click', () => openManualFoodModal());
    $('[data-community-toggle]')?.addEventListener('click', () => openCommunityFoodModal());
    $$('[data-refresh-personal-foods]').forEach(b => b.addEventListener('click', renderPersonalFoods));
    await renderSelectedDateEntries();
  }

  function foodCard(food) {
    const n = food.nutrients || {};
    const serving = food.servingSize ? `${moneyless(food.servingSize)}${food.servingUnit ? ` ${escapeHtml(food.servingUnit)}` : ''}` : '100 g';
    const brand = food.brand ? escapeHtml(food.brand) : escapeHtml(food.dataType || 'USDA FoodData Central');
    const verification = food.nutritionVerification || {};
    const warning = Array.isArray(verification.warnings) && verification.warnings.length
      ? `<small class="food-verification-warning">USDA nutrition data has a consistency warning</small>`
      : `<small class="food-verification-ok">Nutrition values passed basic consistency checks</small>`;
    return `<button type="button" class="food-db-card" data-id="${food.id}">
      <strong>${escapeHtml(food.name)}</strong>
      <p>${brand} · ${serving}</p>
      <div class="macro-row"><span>${moneyless(n.calories)} cal</span><span>${moneyless(n.protein)}g protein</span><span>${moneyless(n.carbs)}g carbs</span><span>${moneyless(n.fat)}g fat</span></div>
      ${warning}
    </button>`;
  }

  function personalFoodCard(food) {
    return `<div class="food-db-card personal-food-card" data-personal-food-id="${food.id}">
      <div class="food-card-main"><strong>${escapeHtml(food.name)}</strong>
      <p>My Food · ${moneyless(food.serving_amount)} ${escapeHtml(food.serving_unit)}</p>
      <div class="macro-row"><span>${moneyless(food.calories)} cal</span><span>${moneyless(food.protein)}g protein</span><span>${moneyless(food.carbs)}g carbs</span><span>${moneyless(food.fat)}g fat</span></div></div>
      <button type="button" class="food-delete-button" data-delete-personal-food="${food.id}" aria-label="Delete ${escapeHtml(food.name)}">Delete</button>
    </div>`;
  }

  function communityFoodCard(food) {
    const author = food.author_profile?.display_name || 'MacroSync User';
    const role = food.author_profile?.role === 'trainer' ? 'Personal Trainer' : 'User';
    const mine = String(food.user_id) === String(user.id);
    return `<div class="food-db-card community-food-card" data-community-food-id="${food.id}">
      <div class="food-card-main"><strong>${escapeHtml(food.name)}</strong>
      <p>Community Food · ${escapeHtml(food.serving_options?.[0]?.amount || 1)} ${escapeHtml(food.serving_options?.[0]?.unit || 'serving')}</p>
      <p class="food-author">@${escapeHtml(author)} · ${escapeHtml(role)}</p>
      <div class="macro-row"><span>${moneyless(food.calories_per_100g)} cal/100g</span><span>${moneyless(food.protein_per_100g)}g protein</span><span>${moneyless(food.carbs_per_100g)}g carbs</span><span>${moneyless(food.fat_per_100g)}g fat</span></div></div>
      ${mine ? `<button type="button" class="food-delete-button" data-delete-community-food="${food.id}" aria-label="Delete ${escapeHtml(food.name)}">Delete</button>` : ''}
    </div>`;
  }

  async function findCommunityAuthorIds(authorQuery) {
    const q = authorQuery.replace(/^@+/, '').trim();
    if (!q) return [];
    const {data,error}=await supabase.from('profiles').select('id,display_name,role,business_name').or(`display_name.ilike.%${q}%,business_name.ilike.%${q}%`).limit(30);
    if(error) throw error;
    return (data||[]).map(p=>p.id);
  }

  async function renderCommunityFoods(query='') {
    const box=$('[data-community-food-list]') || $('[data-food-database-list]'); if(!box)return;
    const raw=query.trim();
    const authorSearch=raw.startsWith('@');
    let request=supabase.from('community_foods').select('*').eq('is_public', true).order('name').limit(50);
    if(authorSearch){
      const ids=await findCommunityAuthorIds(raw);
      if(!ids.length){box.innerHTML='<p class="page-copy">No users or personal trainers matched that @name.</p>';return;}
      request=request.in('user_id', ids);
    } else {
      request=request.neq('user_id', user.id);
      if(raw) request=request.ilike('name', `%${raw.replace(/[%_]/g,'')}%`);
    }
    const {data,error}=await request;
    if(error){box.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
    const foods=data||[];
    if(foods.length){
      const ids=[...new Set(foods.map(f=>f.user_id).filter(Boolean))];
      const {data:profiles}=await supabase.from('profiles').select('id,display_name,role,business_name').in('id',ids);
      const byId=new Map((profiles||[]).map(p=>[p.id,p]));
      foods.forEach(f=>f.author_profile=byId.get(f.user_id)||null);
    }
    box.innerHTML=foods.length?foods.map(communityFoodCard).join(''):'<p class="page-copy">No published community foods found.</p>';
    box.querySelectorAll('[data-community-food-id]').forEach(card=>card.addEventListener('click',(e)=>{if(e.target.closest('[data-delete-community-food]'))return;const food=foods.find(f=>String(f.id)===card.dataset.communityFoodId);if(food)openServingModal(food,'community');}));
    box.querySelectorAll('[data-delete-community-food]').forEach(button=>button.addEventListener('click',async(e)=>{e.stopPropagation();await deleteCommunityFood(button.dataset.deleteCommunityFood);}));
  }

  async function deletePersonalFood(id) {
    const foodName = document.querySelector(`[data-personal-food-id="${CSS.escape(String(id))}"] strong`)?.textContent || 'this food';
    const {data:food,error:lookupError}=await supabase.from('user_foods').select('id,name,community_food_id').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(lookupError){alert(lookupError.message);return;}
    if(!food)return;

    const communityId=food.community_food_id;
    let deleteCommunity=false;
    if(communityId){
      const choice=await choosePersonalFoodDelete(foodName);
      if(choice==='cancel')return;
      deleteCommunity=choice==='both';
    } else if(!confirm(`Delete ${foodName} from My Foods?`)) {
      return;
    }

    if(deleteCommunity){
      const {error}=await supabase.from('community_foods').delete().eq('id',communityId).eq('user_id',user.id);
      if(error){alert(error.message);return;}
    }

    const {error}=await supabase.from('user_foods').delete().eq('id',id).eq('user_id',user.id);
    if(error){alert(error.message);return;}
    await renderPersonalFoods();
    if(deleteCommunity && $('[data-food-source].active')?.dataset.foodSource==='community') {
      await renderCommunityFoods($('[data-food-search]')?.value || '');
    }
  }

  function choosePersonalFoodDelete(foodName){
    return new Promise(resolve=>{
      const overlay=document.createElement('div');
      overlay.className='modal-overlay';
      overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="deleteFoodTitle"><button class="modal-close" data-delete-choice="cancel" type="button">×</button><p class="eyebrow">Delete food</p><h2 id="deleteFoodTitle">${escapeHtml(foodName)}</h2><p class="page-copy">This personal food is also linked to a Community Food you published. Choose what you want to remove.</p><div class="modal-actions delete-food-actions"><button class="ghost-button" data-delete-choice="cancel" type="button">Cancel</button><button class="ghost-button" data-delete-choice="personal" type="button">Delete from My Foods only</button><button class="primary-button danger-button" data-delete-choice="both" type="button">Delete from both</button></div></section>`;
      document.body.appendChild(overlay);
      const finish=choice=>{overlay.remove();resolve(choice);};
      overlay.querySelectorAll('[data-delete-choice]').forEach(button=>button.addEventListener('click',()=>finish(button.dataset.deleteChoice)));
    });
  }

  async function deleteCommunityFood(id) {
    const foodName = document.querySelector(`[data-community-food-id="${CSS.escape(String(id))}"] strong`)?.textContent || 'this food';
    if(!confirm(`Delete ${foodName} from Community Foods? A linked copy in My Foods will remain private.`)) return;
    const {error}=await supabase.from('community_foods').delete().eq('id',id).eq('user_id',user.id);
    if(error){alert(error.message);return;}
    await renderCommunityFoods($('[data-food-search]')?.value || '');
  }

  function openCommunityFoodModal(){
    const overlay=document.createElement('div');overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Food databases</p><h2>Add a food</h2><p class="page-copy">Enter nutrition per 100 g and an optional easy serving. You can save the food to your personal database, publish it to the Community Foods database, or do both at the same time.</p><div class="form-grid"><div class="field"><label>Name</label><input data-c-name maxlength="120" placeholder="Egg"></div><div class="field"><label>Calories / 100 g</label><input data-c-cal type="number" min="0" step="0.1"></div><div class="field"><label>Protein / 100 g</label><input data-c-protein type="number" min="0" step="0.1"></div><div class="field"><label>Carbs / 100 g</label><input data-c-carbs type="number" min="0" step="0.1"></div><div class="field"><label>Fat / 100 g</label><input data-c-fat type="number" min="0" step="0.1"></div><div class="field"><label>Easy serving amount</label><input data-c-amount type="number" min="0.01" step="0.01" value="1"></div><div class="field"><label>Easy serving unit</label><input data-c-unit maxlength="40" value="serving" placeholder="egg, slice, cup"></div><div class="field"><label>Serving weight (g)</label><input data-c-grams type="number" min="0.01" step="0.01" value="100"></div></div><label class="toggle-row"><input data-c-personal type="checkbox" checked><span><strong>Save to My Foods</strong><small>Keep a private copy in your personal food database.</small></span></label><label class="toggle-row"><input data-c-publish type="checkbox" checked><span><strong>Publish to Community Foods</strong><small>Make the food searchable by other MacroSync users.</small></span></label><p class="save-status" data-c-status></p><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-c-save type="button">Save food</button></div></section>`;
    document.body.appendChild(overlay);overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-c-save]').onclick=async()=>{
      const status=overlay.querySelector('[data-c-status]');const name=overlay.querySelector('[data-c-name]').value.trim();const cal=Number(overlay.querySelector('[data-c-cal]').value),pro=Number(overlay.querySelector('[data-c-protein]').value),carb=Number(overlay.querySelector('[data-c-carbs]').value),fat=Number(overlay.querySelector('[data-c-fat]').value),amount=Number(overlay.querySelector('[data-c-amount]').value),grams=Number(overlay.querySelector('[data-c-grams]').value),unit=overlay.querySelector('[data-c-unit]').value.trim()||'serving';
      const savePersonal=overlay.querySelector('[data-c-personal]').checked; const publishCommunity=overlay.querySelector('[data-c-publish]').checked;
      const errorMsg=validateDisplayName(name); if(errorMsg){status.textContent=errorMsg;return;}
      if(!savePersonal && !publishCommunity){status.textContent='Choose at least one database.';return;}
      if([cal,pro,carb,fat,amount,grams].some(v=>!Number.isFinite(v)||v<0)||amount<=0||grams<=0){status.textContent='Enter valid non-negative nutrition values and a positive serving weight.';return;}
      if(pro+carb+fat>100.5){status.textContent='The macros exceed 100 g per 100 g and cannot be saved.';return;}
      status.textContent='Saving…';
      const {data,error}=await supabase.rpc('create_food_records', {p_name:name,p_calories_per_100g:cal,p_protein_per_100g:pro,p_carbs_per_100g:carb,p_fat_per_100g:fat,p_serving_amount:amount,p_serving_unit:unit,p_serving_grams:grams,p_save_personal:savePersonal,p_publish_community:publishCommunity,p_personal_source:'community'});
      if(error){status.textContent=error.message;return;}
      overlay.remove(); await renderPersonalFoods(); if (publishCommunity) await renderCommunityFoods();
      if (data?.personal_food_id && savePersonal) {
        const {data:personal}=await supabase.from('user_foods').select('*').eq('id',data.personal_food_id).single();
        if(personal) openServingModal(personal,'personal');
      }
    };
  }

  async function renderPersonalFoods() {
    const box = $('[data-personal-food-list]');
    if (!box) return;
    const { data, error } = await supabase.from('user_foods').select('*').eq('user_id', user.id).order('name');
    if (error) { box.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; return; }
    const foods = data || [];
    box.innerHTML = foods.length ? foods.map(personalFoodCard).join('') : '<p class="page-copy">You have not created any personal foods yet.</p>';
    box.querySelectorAll('[data-personal-food-id]').forEach(card => card.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-personal-food]')) return;
      const food = foods.find(f => String(f.id) === card.dataset.personalFoodId);
      if (food) openServingModal(food, 'personal');
    }));
    box.querySelectorAll('[data-delete-personal-food]').forEach(button => button.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deletePersonalFood(button.dataset.deletePersonalFood);
    }));
  }

  async function renderSavedMeals() {
    const box = $('[data-saved-meal-list]');
    if (!box) return;
    const { data, error } = await supabase.from('saved_meals').select('*, saved_meal_items(*)').eq('user_id', user.id).order('name');
    if (error) { box.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; return; }
    const meals = data || [];
    box.innerHTML = meals.length ? meals.map(savedMealCard).join('') : '<p class="page-copy">No saved meals yet. Save a meal from your diary to log it faster later.</p>';
    box.querySelectorAll('[data-log-saved-meal]').forEach(button => button.addEventListener('click', async () => {
      const meal = meals.find(m => String(m.id) === button.dataset.logSavedMeal);
      if (meal) await logSavedMeal(meal);
    }));
  }

  function savedMealCard(meal) {
    const items = Array.isArray(meal.saved_meal_items) ? meal.saved_meal_items : [];
    const calories = items.reduce((sum, item) => sum + Number(item.calories || 0), 0);
    return `<article class="saved-meal-card"><div><strong>${escapeHtml(meal.name)}</strong><p>${items.length} item${items.length === 1 ? '' : 's'} · ${moneyless(calories)} cal</p></div><button class="ghost-button" type="button" data-log-saved-meal="${meal.id}">Add</button></article>`;
  }

  function openServingModal(food, source) {
    const n = source === 'personal' ? { calories:Number(food.calories)||0, protein:Number(food.protein)||0, carbs:Number(food.carbs)||0, fat:Number(food.fat)||0 } : source === 'community' ? { calories:Number(food.calories_per_100g)||0, protein:Number(food.protein_per_100g)||0, carbs:Number(food.carbs_per_100g)||0, fat:Number(food.fat_per_100g)||0 } : (food.nutrients || {});
    const communityServing = source === 'community' ? (Array.isArray(food.serving_options) && food.serving_options[0]) : null;
    const baseGrams = source === 'personal' ? (food.serving_unit?.toLowerCase().includes('g') ? Number(food.serving_amount) : 100) : 100;
    const usdaServingGrams = source === 'usda' && String(food.servingUnit || '').toLowerCase().includes('g') ? Number(food.servingSize) || 100 : 100;
    const defaultAmount = source === 'community' ? Number(communityServing?.amount || 1) : source === 'personal' ? Number(food.serving_amount || 1) : Number(food.servingSize || 100);
    const defaultUnit = source === 'community' ? (communityServing?.unit || 'serving') : source === 'personal' ? (food.serving_unit || 'serving') : (food.servingUnit || 'g');
    const defaultServingGrams = source === 'community' ? Number(communityServing?.grams || 100) : usdaServingGrams;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card serving-modal" role="dialog" aria-modal="true" aria-labelledby="servingTitle">
      <button class="modal-close" type="button" data-close-modal aria-label="Close">×</button>
      <p class="eyebrow">${source === 'personal' ? 'My Food' : 'USDA Food'}</p><h2 id="servingTitle">${escapeHtml(food.name)}</h2>
      <div class="form-grid serving-controls">
        <div class="field"><label for="servingAmount">Amount</label><input id="servingAmount" type="number" min="0.01" step="0.01" value="${defaultAmount}"></div>
        <div class="field"><label for="servingUnit">Serving type</label><select id="servingUnit">${source==='community' ? `<option value="community">${escapeHtml(defaultUnit)}</option>` : `<option value="serving" ${defaultUnit.toLowerCase().includes('serv')?'selected':''}>serving${source==='usda' && food.householdServing ? ` (${escapeHtml(food.householdServing)})` : ''}</option>`}<option value="g" ${defaultUnit.toLowerCase().includes('g')?'selected':''}>grams</option><option value="oz">ounces</option></select></div>
        <div class="field"><label for="servingMeal">Add to meal</label><select id="servingMeal">${mealOptionsMarkup(userMeals[0]?.name || "Meal 1")}</select></div>
      </div>
      <p class="serving-help">Nutrition updates automatically as you change the amount or serving type. USDA values are normalized to a 100 g basis before serving-size conversion.</p>
      ${(source === 'usda' && food.nutritionVerification?.warnings?.length) ? `<p class="save-status">USDA reports a consistency warning for this food. The record passed the hard validation checks, but the calorie/macro values may differ because of rounding, fiber, or other USDA calculation methods.</p>` : ''}
      <div class="nutrition-summary" data-serving-preview></div>
      <div class="modal-actions"><button class="ghost-button" type="button" data-close-modal>Cancel</button><button class="primary-button" type="button" data-confirm-serving>Add to meal</button></div>
    </section>`;
    document.body.appendChild(overlay);
    const amountInput = overlay.querySelector('#servingAmount');
    const unitSelect = overlay.querySelector('#servingUnit');
    const preview = overlay.querySelector('[data-serving-preview]');

    function calculate() {
      const amount = Math.max(0.01, Number(amountInput.value) || 1);
      const unit = unitSelect.value;
      let multiplier = amount;
      let display = `${moneyless(amount)} ${unit}`;
      if (unit === 'g') multiplier = amount / baseGrams;
      else if (unit === 'oz') multiplier = (amount * 28.3495) / baseGrams;
      else if (source === 'community') multiplier = (amount * defaultServingGrams) / 100;
      else if (source === 'usda') multiplier = (amount * usdaServingGrams) / 100;
      else multiplier = amount;
      const values = { calories:Number(n.calories||0)*multiplier, protein:Number(n.protein||0)*multiplier, carbs:Number(n.carbs||0)*multiplier, fat:Number(n.fat||0)*multiplier };
      preview.innerHTML = `<div><strong>${moneyless(values.calories)}</strong><span>Calories</span></div><div><strong>${moneyless(values.protein)}g</strong><span>Protein</span></div><div><strong>${moneyless(values.carbs)}g</strong><span>Carbs</span></div><div><strong>${moneyless(values.fat)}g</strong><span>Fat</span></div>`;
      return { amount, unit, display, values };
    }
    amountInput.oninput = calculate; unitSelect.onchange = calculate; calculate();
    overlay.querySelectorAll('[data-close-modal]').forEach(b => b.onclick = () => overlay.remove());
    overlay.querySelector('[data-confirm-serving]').onclick = async () => {
      const result = calculate();
      const meal = overlay.querySelector('#servingMeal').value;
      const payload = { user_id:user.id, logged_date:dateKey(selectedDate), meal, food_name:food.name, serving:result.display, fdc_id:source==='usda' ? Number(food.id) : (food.fdc_id ? Number(food.fdc_id) : null), calories:result.values.calories, protein:result.values.protein, carbs:result.values.carbs, fat:result.values.fat };
      const { error } = await supabase.from('food_entries').insert(payload);
      if (error) { alert(error.message); return; }
      overlay.remove(); await renderSelectedDateEntries(); await renderPersonalFoods();
    };
  }

  function openManualFoodModal() {
    const overlay = document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" type="button" data-close-modal>×</button><p class="eyebrow">Food databases</p><h2>Create manual food</h2><p class="page-copy">Create a food using its nutrition per serving. You can keep it private, publish it to Community Foods, or save it to both databases at once.</p>
      <div class="form-grid"><div class="field"><label>Name</label><input data-manual-name placeholder="Homemade burrito"></div><div class="field"><label>Serving amount</label><input data-manual-serving type="number" min="0.01" step="0.01" value="1"></div><div class="field"><label>Serving type</label><input data-manual-unit value="serving" placeholder="serving, g, cup..."></div><div class="field"><label>Serving weight (g)</label><input data-manual-grams type="number" min="0.01" step="0.01" value="100"></div><div class="field"><label>Calories</label><input data-manual-cal type="number" min="0" step="0.1"></div><div class="field"><label>Protein (g)</label><input data-manual-protein type="number" min="0" step="0.1"></div><div class="field"><label>Carbs (g)</label><input data-manual-carbs type="number" min="0" step="0.1"></div><div class="field"><label>Fat (g)</label><input data-manual-fat type="number" min="0" step="0.1"></div></div>
      <label class="toggle-row"><input data-manual-community type="checkbox"><span><strong>Also publish to Community Foods</strong><small>The serving nutrition is converted to a per-100 g community record using the serving weight.</small></span></label>
      <div class="modal-actions"><button class="ghost-button" data-close-modal type="button">Cancel</button><button class="primary-button" data-save-manual type="button">Save food & add to meal</button></div><p class="save-status" data-manual-status></p></section>`;
    document.body.appendChild(overlay); overlay.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-save-manual]').onclick=async()=>{
      const status=overlay.querySelector('[data-manual-status]'); const name=overlay.querySelector('[data-manual-name]').value.trim(); if(!name){status.textContent='Enter a food name.';return;}
      const servingAmount=Number(overlay.querySelector('[data-manual-serving]').value), grams=Number(overlay.querySelector('[data-manual-grams]').value), calories=Number(overlay.querySelector('[data-manual-cal]').value)||0, protein=Number(overlay.querySelector('[data-manual-protein]').value)||0, carbs=Number(overlay.querySelector('[data-manual-carbs]').value)||0, fat=Number(overlay.querySelector('[data-manual-fat]').value)||0, unit=overlay.querySelector('[data-manual-unit]').value.trim()||'serving';
      const publishCommunity=overlay.querySelector('[data-manual-community]').checked;
      const errorMsg=validateDisplayName(name); if(errorMsg){status.textContent=errorMsg;return;}
      if(!Number.isFinite(servingAmount)||servingAmount<=0||!Number.isFinite(grams)||grams<=0||[calories,protein,carbs,fat].some(v=>!Number.isFinite(v)||v<0)){status.textContent='Enter valid nutrition values and a positive serving weight.';return;}
      if(protein+carbs+fat>100.5){status.textContent='The macros exceed 100 g per 100 g and cannot be saved.';return;}
      status.textContent='Saving…';
      const {data,error}=await supabase.rpc('create_food_records', {p_name:name,p_calories_per_100g:calories*100/grams,p_protein_per_100g:protein*100/grams,p_carbs_per_100g:carbs*100/grams,p_fat_per_100g:fat*100/grams,p_serving_amount:servingAmount,p_serving_unit:unit,p_serving_grams:grams,p_save_personal:true,p_publish_community:publishCommunity,p_personal_calories:calories,p_personal_protein:protein,p_personal_carbs:carbs,p_personal_fat:fat});
      if(error){status.textContent=error.message;return;}
      overlay.remove(); await renderPersonalFoods(); if(publishCommunity) await renderCommunityFoods();
      const personalId=data?.personal_food_id;
      if(personalId){const {data:personal}=await supabase.from('user_foods').select('*').eq('id',personalId).single(); if(personal) openServingModal(personal,'personal');}
    };
  }

  async function saveManualFoodAndLog() { openManualFoodModal(); }

  async function logSavedMeal(meal) {
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Saved meal</p><h2>${escapeHtml(meal.name)}</h2><div class="field"><label for="savedMealDestination">Add to meal</label><select id="savedMealDestination">${mealOptionsMarkup(userMeals[0]?.name || '')}</select></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-confirm-saved-meal type="button">Add to meal</button></div></section>`;
    document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-confirm-saved-meal]').onclick=async()=>{const mealName=overlay.querySelector('#savedMealDestination').value;const items=(meal.saved_meal_items||[]).map(item=>({user_id:user.id,logged_date:dateKey(selectedDate),meal:mealName,food_name:item.food_name,serving:item.serving,fdc_id:item.fdc_id,calories:item.calories,protein:item.protein,carbs:item.carbs,fat:item.fat}));if(!items.length)return;const {error}=await supabase.from('food_entries').insert(items);if(error){alert(error.message);return;}overlay.remove();await renderSelectedDateEntries();};
  }

  async function saveCurrentMealAsSaved(mealName) {
    const entries = (await getEntries()).filter(e => e.meal === mealName);
    if (!entries.length) { alert(`There are no foods logged under ${mealName}.`); return; }
    const name = prompt(`Name this saved ${mealName.toLowerCase()} meal:`, `My ${mealName}`); if (!name?.trim()) return;
    const { data: saved, error } = await supabase.from('saved_meals').insert({user_id:user.id,name:name.trim()}).select('*').single();
    if(error){alert(error.message);return;}
    const items = entries.map(e => ({saved_meal_id:saved.id,user_id:user.id,food_name:e.food_name,serving:e.serving,fdc_id:e.fdc_id,calories:e.calories,protein:e.protein,carbs:e.carbs,fat:e.fat}));
    const {error:itemError}=await supabase.from('saved_meal_items').insert(items); if(itemError){alert(itemError.message);return;}
    await renderSavedMeals(); alert(`${name.trim()} was saved.`);
  }

  async function saveFood() { openManualFoodModal(); }

  async function renderSelectedDateEntries(){ const list=$('[data-meal-list]'); if(!list)return; const entries=await getEntries(); await renderMeals(entries); }

  async function renderSettings(){
    const nameInput = $('#settingsDisplayName');
    const emailInput = $('#settingsEmail');
    const roleText = $('#settingsRole');
    const status = $('[data-settings-status]');
    const feedbackStatus = $('[data-feedback-status]');
    const { data: profile, error } = await supabase.from('profiles').select('display_name,email,role,business_name,is_admin').eq('id', user.id).single();
    if (error) { if (status) status.textContent = error.message; return; }
    if (nameInput) nameInput.value = profile?.display_name || user.user_metadata?.display_name || '';
    if (emailInput) emailInput.value = user.email || profile?.email || '';
    if (roleText) roleText.textContent = profile?.role === 'trainer' ? `Personal trainer${profile?.business_name ? ` · ${profile.business_name}` : ''}` : 'Normal user';

    $('[data-settings-profile-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const displayName = nameInput.value.trim();
      const displayNameValidation = validateDisplayName(displayName);
      if (displayNameValidation) { status.textContent = displayNameValidation; return; }
      status.textContent = 'Saving…';
      const { error: profileError } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
      if (profileError) { status.textContent = profileError.message; return; }
      const { error: authError } = await supabase.auth.updateUser({ data: { display_name: displayName } });
      if (authError) { status.textContent = authError.message; return; }
      user.user_metadata = { ...(user.user_metadata || {}), display_name: displayName };
      await supabase.from('moderation_flags').update({ status:'resolved', resolved_at:new Date().toISOString() }).eq('user_id', user.id).eq('content_type','display_name').eq('status','open');
      status.textContent = 'Display name updated.';
    });

    $('[data-settings-password-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const password = $('#settingsPassword').value;
      const confirm = $('#settingsPasswordConfirm').value;
      if (password.length < 8) { status.textContent = 'Password must be at least 8 characters.'; return; }
      if (password !== confirm) { status.textContent = 'The passwords do not match.'; return; }
      status.textContent = 'Updating password…';
      const { error: passwordError } = await supabase.auth.updateUser({ password });
      if (passwordError) { status.textContent = passwordError.message; return; }
      $('#settingsPassword').value = '';
      $('#settingsPasswordConfirm').value = '';
      status.textContent = 'Password updated successfully.';
    });

    $('[data-settings-email-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const newEmail = emailInput.value.trim();
      if (!newEmail) { status.textContent = 'Enter an email address.'; return; }
      if (newEmail === user.email) { status.textContent = 'That is already your current email.'; return; }
      status.textContent = 'Updating email…';
      const { error: emailError } = await supabase.auth.updateUser({ email: newEmail });
      if (emailError) { status.textContent = emailError.message; return; }
      await supabase.from('profiles').update({ email: newEmail }).eq('id', user.id);
      status.textContent = 'Email change requested. Check your inbox for any confirmation link.';
    });

    $('[data-feedback-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const category = $('#feedbackCategory').value;
      const message = $('#feedbackMessage').value.trim();
      const feedbackValidation = validateMessageText(message);
      if (feedbackValidation) { feedbackStatus.textContent = feedbackValidation; return; }
      feedbackStatus.textContent = 'Sending feedback…';
      const { error: feedbackError } = await supabase.from('feedback').insert({ user_id: user.id, category, message });
      if (feedbackError) { feedbackStatus.textContent = feedbackError.message; return; }
      $('#feedbackMessage').value = '';
      feedbackStatus.textContent = 'Thanks! Your feedback was submitted.';
    });

    const isAdmin = profile?.is_admin === true;
    $$('[data-admin-only]').forEach(el => { el.hidden = !isAdmin; });
    const emailSearchToggle = $('[data-email-search-enabled]');
    if (emailSearchToggle) emailSearchToggle.checked = profile?.email_search_enabled !== false;
    emailSearchToggle?.addEventListener('change', async () => {
      const { error } = await supabase.from('profiles').update({ email_search_enabled: emailSearchToggle.checked }).eq('id', user.id);
      if (error) { emailSearchToggle.checked = !emailSearchToggle.checked; alert(error.message); }
    });
    $('[data-delete-account]')?.addEventListener('click', async () => {
      if (!confirm('Delete your MacroSync account and all of its application data permanently? This cannot be undone.')) return;
      const ds = $('[data-delete-account-status]'); if (ds) ds.textContent = 'Deleting account…';
      const { data, error } = await supabase.rpc('delete_my_account');
      if (error) { if (ds) ds.textContent = error.message; return; }
      await supabase.auth.signOut();
      window.location.href = 'auth.html';
    });
    const tabs = $$('[data-settings-tab]');
    const sections = $$('[data-settings-section]');
    const showTab = async tab => {
      if (tab === 'feedback-inbox' && !isAdmin) return;
      tabs.forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
      sections.forEach(sec => { sec.hidden = sec.dataset.settingsSection !== tab; });
      if (tab === 'feedback-inbox') await loadFeedbackInbox();
    };
    tabs.forEach(b => b.onclick = () => showTab(b.dataset.settingsTab));

    async function loadFeedbackInbox(){
      const box = $('[data-feedback-inbox]'); const inboxStatus = $('[data-feedback-inbox-status]');
      if (!box) return; inboxStatus.textContent = 'Loading feedback…';
      const { data, error } = await supabase.from('feedback').select('id,user_id,category,message,created_at,read_at,profiles!feedback_user_id_profiles_fkey(display_name,email)').order('created_at',{ascending:false});
      if (error) { inboxStatus.textContent = error.message; return; }
      const unread = (data||[]).filter(x => !x.read_at).length;
      $$('[data-feedback-unread-count]').forEach(b => { b.hidden = unread === 0; b.textContent = unread; });
      box.innerHTML = (data||[]).length ? data.map(item => `
        <article class="feedback-item ${item.read_at ? '' : 'unread'}" data-feedback-id="${item.id}">
          <div class="feedback-item-head"><strong>${escapeHtml(item.category)}</strong><span>${new Date(item.created_at).toLocaleString()}</span></div>
          <div class="feedback-author">${escapeHtml(item.profiles?.display_name || 'Unknown user')} · ${escapeHtml(item.profiles?.email || '')}</div>
          <p>${escapeHtml(item.message)}</p>
          <div class="feedback-actions"><button class="ghost-button" type="button" data-mark-feedback-read="${item.id}" ${item.read_at ? 'disabled' : ''}>Mark as read</button><button class="ghost-button danger-button" type="button" data-delete-feedback="${item.id}">Delete</button></div>
        </article>`).join('') : '<p class="empty-state">No feedback has been submitted yet.</p>';
      inboxStatus.textContent = '';
      box.querySelectorAll('[data-mark-feedback-read]').forEach(b => b.onclick = async () => { await supabase.from('feedback').update({read_at:new Date().toISOString()}).eq('id',b.dataset.markFeedbackRead); await loadFeedbackInbox(); });
      box.querySelectorAll('[data-delete-feedback]').forEach(b => b.onclick = async () => { if (!confirm('Delete this feedback permanently?')) return; const {error}=await supabase.from('feedback').delete().eq('id',b.dataset.deleteFeedback); if(error) { inboxStatus.textContent=error.message; return; } await loadFeedbackInbox(); });
    }
    $('[data-refresh-feedback]')?.addEventListener('click', loadFeedbackInbox);
    if (isAdmin) {
      const { count } = await supabase.from('feedback').select('*',{count:'exact',head:true}).is('read_at',null);
      $$('[data-feedback-unread-count]').forEach(b => { b.hidden = !(count||0); b.textContent = count||0; });
    }
  }

  async function renderAccount(){
    const {data:profile,error}=await supabase.from('profiles').select('*').eq('id',user.id).single();
    if(error) throw error;
    $('#accountName').value=profile?.display_name || '';
    $('#businessName').value=profile?.business_name || '';
    const roleControls=$$('.account-type button');
    roleControls.forEach(btn=>{
      btn.classList.toggle('active',btn.dataset.accountRole===profile?.role);
      btn.onclick=()=>{ roleControls.forEach(b=>b.classList.remove('active')); btn.classList.add('active'); $('#businessName').closest('[data-business-field]').hidden=btn.dataset.accountRole!=='trainer'; };
    });
    $('[data-business-field]').hidden=profile?.role!=='trainer';
    const button=$('[data-add-account]');
    if(button) button.onclick=async()=>{
      const name=$('#accountName').value.trim()||'MacroSync User';
      const role=$('.account-type button.active')?.dataset.accountRole || 'user';
      const business=role==='trainer' ? $('#businessName').value.trim() || null : null;
      const {error}=await supabase.from('profiles').update({display_name:name,role,business_name:business}).eq('id',user.id);
      const old=button.parentElement.querySelector('.save-status'); old?.remove();
      const status=document.createElement('p'); status.className='save-status'; status.textContent=error?error.message:'Profile saved.'; button.parentElement.appendChild(status);
    };
    const list=$('[data-account-list]');
    if(list) list.innerHTML=`<div class="account-card selected"><div class="account-top"><div class="profile-strip"><span class="avatar">${escapeHtml((profile?.display_name||'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(profile?.display_name||'MacroSync User')}</strong><p>${profile?.role==='trainer'?'Personal trainer':'Normal user'}${profile?.business_name?' · '+escapeHtml(profile.business_name):''}</p></span></div><span class="role-badge">${profile?.role==='trainer'?'Trainer':'Alpha'}</span></div></div>`;
  }

  async function renderGoals(){
    const goals=await getGoals();
    const {data:profile}=await supabase.from('profiles').select('primary_goal').eq('id',user.id).single();
    $('#calgoal').value=goals.calorie_goal;
    $('#proteinGoal').value=goals.protein_goal;
    $('#carbsGoal').value=goals.carbs_goal;
    $('#fatGoal').value=goals.fat_goal;
    $('#currentWeight').value=goals.current_weight ?? '';
    $('#goalWeight').value=goals.goal_weight ?? '';
    $('#primaryGoal').value=profile?.primary_goal || 'health';
    $('[data-current-weight]').textContent=goals.current_weight ? moneyless(goals.current_weight) : '—';
    $('[data-goal-weight]').textContent=goals.goal_weight ? moneyless(goals.goal_weight) : '—';

    const autoStatus=$('[data-auto-macro-status]');
    const autoButton=$('[data-auto-calculate]');
    const updateAutoState=()=>{
      const goal=$('#primaryGoal').value;
      const weight=Number($('#currentWeight').value);
      const supported=['lose','maintain','gain'].includes(goal);
      const configured=supported && autoMacroRulesConfigured(goal);
      if(autoButton) autoButton.disabled=false;
      if(autoStatus) autoStatus.textContent='Automatic macro calculation is not yet available. It is coming at a later date.';
    };
    ['#currentWeight','#primaryGoal'].forEach(selector=>$(selector)?.addEventListener('input',updateAutoState));
    updateAutoState();

    autoButton?.addEventListener('click',()=>{
      if(autoStatus) autoStatus.textContent='Automatic macro calculation is not yet available. It is coming at a later date.';
    });

    const button=$('.two-column-grid .panel .primary-button');
    if(button){button.onclick=async()=>{
      const payload={user_id:user.id,calorie_goal:Number($('#calgoal').value)||2050,protein_goal:Number($('#proteinGoal').value)||0,carbs_goal:Number($('#carbsGoal').value)||0,fat_goal:Number($('#fatGoal').value)||0,current_weight:Number($('#currentWeight').value)||null,goal_weight:Number($('#goalWeight').value)||null};
      const {error}=await supabase.from('nutrition_goals').upsert(payload);
      if(!error){ await supabase.from('profiles').update({primary_goal:$('#primaryGoal').value}).eq('id',user.id); }
      button.parentElement.querySelector('.save-status')?.remove(); const status=document.createElement('p');status.className='save-status';status.textContent=error?error.message:'Goals saved.';button.parentElement.appendChild(status);
      if(!error){ $('[data-current-weight]').textContent=payload.current_weight ? moneyless(payload.current_weight) : '—'; $('[data-goal-weight]').textContent=payload.goal_weight ? moneyless(payload.goal_weight) : '—'; }
    };}
  }

  async function renderProgress(){
    const { data: allEntries, error: entryError } = await supabase.from('food_entries').select('logged_date').eq('user_id', user.id).order('logged_date', {ascending:true});
    if(entryError) throw entryError;
    const dates=[...new Set((allEntries||[]).map(e=>e.logged_date).filter(Boolean))].sort();
    const dateSet=new Set(dates);
    let current=0, longest=0, run=0, previous=null;
    for(const d of dates){
      const cur=new Date(`${d}T00:00:00`);
      if(previous && Math.round((cur-previous)/86400000)===1) run++; else run=1;
      current=run; longest=Math.max(longest,run); previous=cur;
    }
    setText('[data-current-streak]', current);
    setText('[data-longest-streak]', longest);
    setText('[data-days-logged]', dates.length);
    renderActivity(dates, dateSet);

    const {data:weights,error:weightError}=await supabase.from('weight_logs').select('*').eq('user_id',user.id).order('logged_date',{ascending:true}).order('created_at',{ascending:true});
    if(weightError) throw weightError;
    renderWeightProgress(weights||[]);

    const {data:measurements,error:measurementError}=await supabase.from('body_measurements').select('*').eq('user_id',user.id).order('logged_date',{ascending:false}).order('created_at',{ascending:false});
    if(measurementError) throw measurementError;
    renderMeasurements(measurements||[]);

    $('[data-add-weight]')?.addEventListener('click', openWeightModal);
    $('[data-add-measurement]')?.addEventListener('click', openMeasurementModal);
  }

  function renderActivity(dates,dateSet){
    const grid=$('[data-activity-grid]'); if(!grid) return;
    const today=new Date(); today.setHours(0,0,0,0);
    const start=addDays(today,-27);
    const days=[];
    for(let i=0;i<28;i++){const d=addDays(start,i);const key=dateKey(d);days.push(`<div class="activity-day ${dateSet.has(key)?'logged':''}" title="${d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}"><span></span><small>${d.getDate()}</small></div>`);}
    grid.innerHTML=days.join('');
  }

  function renderWeightProgress(weights){
    const chart=$('[data-weight-chart]');
    if(!weights.length){
      setText('[data-current-progress-weight]','—'); setText('[data-weight-change]','Log a weight to start your history.'); setText('[data-start-weight]','—'); setText('[data-weight-change-total]','—'); setText('[data-lowest-weight]','—');
      if(chart) chart.innerHTML='<p class="page-copy">No weight history yet. Log your first weight above.</p>';
      return;
    }
    const first=Number(weights[0].weight), last=Number(weights[weights.length-1].weight), lowest=Math.min(...weights.map(w=>Number(w.weight))), change=last-first;
    setText('[data-current-progress-weight]',`${moneyless(last)} lb`); setText('[data-weight-change]',`${change===0?'No change':`${change>0?'+':''}${moneyless(change)} lb`} since first logged weight.`); setText('[data-start-weight]',`${moneyless(first)} lb`); setText('[data-weight-change-total]',`${change>0?'+':''}${moneyless(change)} lb`); setText('[data-lowest-weight]',`${moneyless(lowest)} lb`);
    if(!chart) return;
    const width=760,height=260,pad=38,vals=weights.map(w=>Number(w.weight)),min=Math.min(...vals),max=Math.max(...vals),range=Math.max(max-min,1);
    const points=weights.map((w,i)=>{const x=pad+(i/(Math.max(weights.length-1,1)))*(width-pad*2);const y=pad+((max-Number(w.weight))/range)*(height-pad*2);return {x,y,w};});
    const poly=points.map(p=>`${p.x},${p.y}`).join(' ');
    chart.innerHTML=`<svg class="weight-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weight history"><line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" class="chart-axis"/><polyline points="${poly}" class="weight-line" fill="none"/>${points.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" class="weight-point"><title>${moneyless(p.w.weight)} lb · ${p.w.logged_date}</title></circle>`).join('')}<text x="${pad}" y="${height-8}" class="chart-label">${weights[0].logged_date}</text><text x="${width-pad}" y="${height-8}" text-anchor="end" class="chart-label">${weights[weights.length-1].logged_date}</text><text x="${pad}" y="18" class="chart-label">${moneyless(max)} lb</text><text x="${pad}" y="${height-28}" class="chart-label">${moneyless(min)} lb</text></svg>`;
    const history=$('[data-weight-history]'); if(history) { history.innerHTML=weights.slice().reverse().map(w=>`<div class="history-row"><div><strong>${moneyless(w.weight)} lb</strong><span>${w.logged_date}</span></div><button class="text-button danger-button" type="button" data-delete-weight="${w.id}">Delete</button></div>`).join(''); history.querySelectorAll('[data-delete-weight]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this weight entry permanently?'))return;const {error}=await supabase.from('weight_logs').delete().eq('id',b.dataset.deleteWeight).eq('user_id',user.id);if(error)return alert(error.message);await renderProgress();}); }
  }

  function renderMeasurements(rows){
    const list=$('[data-measurement-list]'); if(!list) return;
    const latest=new Map(); rows.forEach(r=>{if(!latest.has(r.measurement_type)) latest.set(r.measurement_type,r);});
    const order=['Waist','Hips','Chest','Left arm','Right arm','Left thigh','Right thigh','Neck'];
    const keys=[...order.filter(k=>latest.has(k)),...Array.from(latest.keys()).filter(k=>!order.includes(k))];
    list.innerHTML=keys.length?keys.map(k=>{const r=latest.get(k);return `<article class="measurement-card"><div><strong>${escapeHtml(k)}</strong><span>${moneyless(r.value)} ${r.unit}</span></div><small>${r.logged_date}</small><div class="measurement-actions"><button type="button" class="text-button" data-measurement-history="${escapeHtml(k)}">History</button><button type="button" class="text-button danger-button" data-delete-measurement="${r.id}">Delete latest</button></div></article>`}).join(''):'<p class="page-copy">No measurements logged yet.</p>';
    list.querySelectorAll('[data-measurement-history]').forEach(b=>b.onclick=()=>showMeasurementHistory(b.dataset.measurementHistory,rows)); list.querySelectorAll('[data-delete-measurement]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this measurement entry permanently?'))return;const {error}=await supabase.from('body_measurements').delete().eq('id',b.dataset.deleteMeasurement).eq('user_id',user.id);if(error)return alert(error.message);await renderProgress();});
  }

  function openWeightModal(){
    const overlay=document.createElement('div'); overlay.className='modal-overlay'; overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Weight</p><h2>Log weight</h2><div class="field"><label>Weight (lb)</label><input id="progressWeightInput" type="number" min="1" step="0.1" autofocus></div><div class="field"><label>Date</label><input id="progressWeightDate" type="date" value="${dateKey(new Date())}"></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-weight type="button">Save</button></div></section>`; document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove()); overlay.querySelector('[data-save-weight]').onclick=async()=>{const weight=Number(overlay.querySelector('#progressWeightInput').value),logged_date=overlay.querySelector('#progressWeightDate').value;if(!weight||!logged_date)return alert('Enter a valid weight and date.');const {error}=await supabase.from('weight_logs').insert({user_id:user.id,weight,logged_date});if(error)return alert(error.message);overlay.remove();await renderProgress();};
  }

  function openMeasurementModal(){
    const overlay=document.createElement('div'); overlay.className='modal-overlay'; overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Measurements</p><h2>Add measurement</h2><div class="form-grid"><div class="field"><label>Measurement</label><select id="measurementType"><option>Waist</option><option>Hips</option><option>Chest</option><option>Left arm</option><option>Right arm</option><option>Left thigh</option><option>Right thigh</option><option>Neck</option><option>Custom</option></select></div><div class="field"><label>Value</label><input id="measurementValue" type="number" min="0.1" step="0.1"></div><div class="field"><label>Unit</label><select id="measurementUnit"><option value="in">inches</option><option value="cm">centimeters</option></select></div><div class="field"><label>Date</label><input id="measurementDate" type="date" value="${dateKey(new Date())}"></div></div><div class="field" id="customMeasurementWrap" hidden><label>Custom name</label><input id="customMeasurementName" maxlength="40"></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-measurement type="button">Save</button></div></section>`; document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove()); const type=overlay.querySelector('#measurementType'), custom=overlay.querySelector('#customMeasurementWrap'); type.onchange=()=>custom.hidden=type.value!=='Custom'; overlay.querySelector('[data-save-measurement]').onclick=async()=>{const measurement_type=type.value==='Custom'?overlay.querySelector('#customMeasurementName').value.trim():type.value;const value=Number(overlay.querySelector('#measurementValue').value),unit=overlay.querySelector('#measurementUnit').value,logged_date=overlay.querySelector('#measurementDate').value;if(!measurement_type||!value||!logged_date)return alert('Complete the measurement fields.');const {error}=await supabase.from('body_measurements').insert({user_id:user.id,measurement_type,value,unit,logged_date});if(error)return alert(error.message);overlay.remove();await renderProgress();};
  }

  function showMeasurementHistory(name,rows){
    const history=rows.filter(r=>r.measurement_type===name).sort((a,b)=>String(b.logged_date).localeCompare(String(a.logged_date))); const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Measurement history</p><h2>${escapeHtml(name)}</h2><div class="history-list">${history.map(r=>`<div class="history-row"><div><strong>${moneyless(r.value)} ${r.unit}</strong><span>${r.logged_date}</span></div><button class="text-button danger-button" type="button" data-delete-history-measurement="${r.id}">Delete</button></div>`).join('')}</div></section>`;document.body.appendChild(overlay);overlay.querySelector('[data-close]').onclick=()=>overlay.remove(); overlay.querySelectorAll('[data-delete-history-measurement]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this measurement entry permanently?'))return;const {error}=await supabase.from('body_measurements').delete().eq('id',b.dataset.deleteHistoryMeasurement).eq('user_id',user.id);if(error)return alert(error.message);overlay.remove();await renderProgress();});
  }

  async function renderRecipes(){
    const list = $('[data-recipe-list]');
    const builder = $('[data-recipe-builder]');
    if (!list || !builder) return;
    await loadRecipes(list);
    const search = builder.querySelector('[data-recipe-food-search]');
    const results = builder.querySelector('[data-recipe-search-results]');
    const ingredientList = builder.querySelector('[data-recipe-ingredients]');
    let ingredients = [];
    const drawIngredients = () => {
      ingredientList.innerHTML = ingredients.length ? ingredients.map((item,index)=>`<div class="recipe-ingredient-row"><div><strong>${escapeHtml(item.name)}</strong><small>${moneyless(item.amount)} ${escapeHtml(item.unit)}</small></div><span>${moneyless(item.calories)} cal</span><button type="button" class="text-button" data-remove-ingredient="${index}">Remove</button></div>`).join('') : '<p class="page-copy">Add ingredients to build your recipe.</p>';
      ingredientList.querySelectorAll('[data-remove-ingredient]').forEach(b=>b.onclick=()=>{ingredients.splice(Number(b.dataset.removeIngredient),1);drawIngredients();});
      const totals=ingredients.reduce((a,i)=>({calories:a.calories+i.calories,protein:a.protein+i.protein,carbs:a.carbs+i.carbs,fat:a.fat+i.fat}),{calories:0,protein:0,carbs:0,fat:0});
      builder.querySelector('[data-recipe-totals]').innerHTML=`<div><strong>${moneyless(totals.calories)}</strong><span>Calories</span></div><div><strong>${moneyless(totals.protein)}g</strong><span>Protein</span></div><div><strong>${moneyless(totals.carbs)}g</strong><span>Carbs</span></div><div><strong>${moneyless(totals.fat)}g</strong><span>Fat</span></div>`;
    };
    drawIngredients();
    search?.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{const q=search.value.trim();if(q.length<2){results.innerHTML='';return;}results.innerHTML='<p class="page-copy">Searching…</p>';try{const r=await fetch(`/api/foods/search?q=${encodeURIComponent(q)}`);const d=await r.json();if(!r.ok)throw new Error(d.error||'Search failed');results.innerHTML=(d.foods||[]).slice(0,8).map(f=>`<button type="button" class="food-db-card" data-recipe-food-id="${f.id}"><strong>${escapeHtml(f.name)}</strong><p>${escapeHtml(f.brand||f.dataType||'USDA')}</p></button>`).join('')||'<p class="page-copy">No foods found.</p>';results.querySelectorAll('[data-recipe-food-id]').forEach(b=>b.onclick=()=>{const f=(d.foods||[]).find(x=>String(x.id)===b.dataset.recipeFoodId);if(!f)return;const n=f.nutrients||{};const amount=Number(f.servingSize||100);const unit=f.servingUnit||'g';const qty=Number(prompt(`How many ${unit} of ${f.name}?`,amount));if(!qty||qty<=0)return;const factor=String(unit).toLowerCase().includes('g') ? qty/100 : qty*amount/100;ingredients.push({name:f.name,amount:qty,unit,fdc_id:f.id,calories:Number(n.calories||0)*factor,protein:Number(n.protein||0)*factor,carbs:Number(n.carbs||0)*factor,fat:Number(n.fat||0)*factor});drawIngredients();});}catch(e){results.innerHTML=`<p class="page-copy">${escapeHtml(e.message)}</p>`}},350)});
    builder.querySelector('[data-save-recipe]')?.addEventListener('click',async()=>{const name=builder.querySelector('[data-recipe-name]').value.trim();const servings=Math.max(1,Number(builder.querySelector('[data-recipe-servings]').value)||1);if(!name||!ingredients.length){alert('Enter a recipe name and add at least one ingredient.');return;}const {data:recipe,error}=await supabase.from('recipes').insert({user_id:user.id,name,servings}).select('*').single();if(error){alert(error.message);return;}const rows=ingredients.map(i=>({recipe_id:recipe.id,user_id:user.id,food_name:i.name,serving:`${moneyless(i.amount)} ${i.unit}`,fdc_id:i.fdc_id,calories:i.calories,protein:i.protein,carbs:i.carbs,fat:i.fat}));const {error:itemError}=await supabase.from('recipe_items').insert(rows);if(itemError){alert(itemError.message);return;}ingredients=[];builder.querySelector('[data-recipe-name]').value='';drawIngredients();await loadRecipes(list);alert(`${name} was saved.`);});
  }

  async function loadRecipes(list){
    const {data,error}=await supabase.from('recipes').select('*, recipe_items(*)').eq('user_id',user.id).order('name');
    if(error){list.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
    const recipes=data||[];list.innerHTML=recipes.length?recipes.map(r=>{const items=r.recipe_items||[];const t=items.reduce((a,i)=>({calories:a.calories+Number(i.calories||0),protein:a.protein+Number(i.protein||0),carbs:a.carbs+Number(i.carbs||0),fat:a.fat+Number(i.fat||0)}),{calories:0,protein:0,carbs:0,fat:0});return `<article class="recipe-card"><div><h2>${escapeHtml(r.name)}</h2><p>${items.length} ingredient${items.length===1?'':'s'} · ${moneyless(t.calories/Number(r.servings||1))} cal per serving</p><div class="macro-row"><span>P ${moneyless(t.protein/Number(r.servings||1))}g</span><span>C ${moneyless(t.carbs/Number(r.servings||1))}g</span><span>F ${moneyless(t.fat/Number(r.servings||1))}g</span></div></div><button class="primary-button" type="button" data-use-recipe="${r.id}">Use recipe</button></article>`}).join(''):'<p class="page-copy">No recipes yet. Create your first reusable recipe above.</p>';
    list.querySelectorAll('[data-use-recipe]').forEach(b=>b.onclick=()=>openRecipeLogModal(recipes.find(r=>String(r.id)===b.dataset.useRecipe)));
  }

  function openRecipeLogModal(recipe){
    const items=recipe?.recipe_items||[];if(!recipe||!items.length)return;const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close-modal type="button">×</button><p class="eyebrow">Recipe</p><h2>${escapeHtml(recipe.name)}</h2><div class="form-grid"><div class="field"><label>Servings</label><input data-recipe-log-amount type="number" min="0.25" step="0.25" value="1"></div><div class="field"><label>Meal</label><select data-recipe-log-meal>${mealOptionsMarkup(userMeals[0]?.name || "Meal 1")}</select></div></div><div data-recipe-log-preview class="nutrition-summary"></div><div class="modal-actions"><button class="ghost-button" data-close-modal type="button">Cancel</button><button class="primary-button" data-confirm-recipe type="button">Add to meal</button></div></section>`;document.body.appendChild(overlay);overlay.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>overlay.remove());const amount=overlay.querySelector('[data-recipe-log-amount]');const preview=overlay.querySelector('[data-recipe-log-preview]');const total=items.reduce((a,i)=>({calories:a.calories+Number(i.calories||0),protein:a.protein+Number(i.protein||0),carbs:a.carbs+Number(i.carbs||0),fat:a.fat+Number(i.fat||0)}),{calories:0,protein:0,carbs:0,fat:0});const per={calories:total.calories/Number(recipe.servings||1),protein:total.protein/Number(recipe.servings||1),carbs:total.carbs/Number(recipe.servings||1),fat:total.fat/Number(recipe.servings||1)};const calc=()=>{const x=Number(amount.value)||1;preview.innerHTML=`<div><strong>${moneyless(per.calories*x)}</strong><span>Calories</span></div><div><strong>${moneyless(per.protein*x)}g</strong><span>Protein</span></div><div><strong>${moneyless(per.carbs*x)}g</strong><span>Carbs</span></div><div><strong>${moneyless(per.fat*x)}g</strong><span>Fat</span></div>`};amount.oninput=calc;calc();overlay.querySelector('[data-confirm-recipe]').onclick=async()=>{const x=Number(amount.value)||1;const meal=overlay.querySelector('[data-recipe-log-meal]').value;const row={user_id:user.id,logged_date:dateKey(selectedDate),meal,food_name:recipe.name,serving:`${moneyless(x)} serving${x===1?'':'s'}`,fdc_id:null,calories:per.calories*x,protein:per.protein*x,carbs:per.carbs*x,fat:per.fat*x};const {error}=await supabase.from('food_entries').insert(row);if(error){alert(error.message);return;}overlay.remove();await renderSelectedDateEntries();};
  }

  async function renderAdmin() {
    const gate = $('[data-admin-dashboard]'); if (!gate) return;
    const { data: profile, error: profileError } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
    if (profileError || !profile?.is_admin) { gate.innerHTML = '<section class="panel"><h2>Administrator access required</h2><p class="page-copy">This page is restricted to MacroSync administrators.</p></section>'; return; }
    const status = $('[data-admin-status]');
    const esc = escapeHtml;
    const loadFlags = async () => {
      const list = $('[data-admin-queue]');
      const { data, error } = await supabase.rpc('admin_list_moderation_queue');
      if (error) { list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`; return; }
      const flags=data||[];
      list.innerHTML=flags.length?flags.map(f=>{const isName=f.content_type==='display_name';const actions=isName?'<button class="primary-button" data-admin-action="replace">Change name</button><button class="ghost-button danger-button" data-admin-action="reset_name">Reset name</button>':'<button class="primary-button" data-admin-action="replace">Replace message</button><button class="ghost-button danger-button" data-admin-action="delete">Delete message</button>';return `<article class="admin-flag-item" data-admin-flag="${f.flag_id}"><div class="feedback-item-head"><strong>${esc(isName?'Flagged display name':'Flagged message')}</strong><span>${new Date(f.created_at).toLocaleString()}</span></div><div class="feedback-author">${esc(f.display_name||'Unknown')} · ${esc(f.email||'Email hidden')}</div><p><strong>Reason:</strong> ${esc(f.reason)}</p><div class="admin-content-preview">${esc(f.content||'[content unavailable]')}</div><div class="field"><label>Replacement</label><textarea rows="2" data-admin-replacement></textarea></div><div class="field"><label>Message to user</label><textarea rows="2" data-admin-note placeholder="Explain the action and what the user should do next."></textarea></div><div class="feedback-actions">${actions}<button class="ghost-button" data-admin-status-action="${f.user_id}">Suspend / ban account</button></div></article>`}).join(''):'<p class="empty-state">No open flagged names or messages.</p>';
      list.querySelectorAll('[data-admin-action]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-admin-flag]');const {error}=await supabase.rpc('admin_moderation_action',{p_flag_id:Number(card.dataset.adminFlag),p_action:btn.dataset.adminAction,p_replacement:card.querySelector('[data-admin-replacement]')?.value||null,p_note:card.querySelector('[data-admin-note]')?.value||null});if(error){alert(error.message);return;}await loadFlags();});
      list.querySelectorAll('[data-admin-status-action]').forEach(btn=>btn.onclick=()=>openAccountStatusModal(btn.dataset.adminStatusAction));
      return flags.length;
    };
    const loadReports = async () => {
      const list=$('[data-admin-reports]'); const {data,error}=await supabase.rpc('admin_list_reports');
      if(error){list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`;return;}
      const reports=data||[]; list.innerHTML=reports.length?reports.map(r=>`<article class="admin-flag-item" data-report="${r.report_id}" data-reported-user="${r.reported_user_id}"><div class="feedback-item-head"><strong>Report #${r.report_id}</strong><span>${new Date(r.created_at).toLocaleString()}</span></div><div class="feedback-author">Reporter: ${esc(r.reporter_name)} · Reported: ${esc(r.reported_name)}</div><p><strong>Reason:</strong> ${esc(r.reason)}</p><div class="admin-content-preview">${esc(r.message_content||'[message deleted]')}</div><div class="field"><label>Admin note</label><textarea rows="2" data-report-note placeholder="Explain the action taken."></textarea></div><div class="feedback-actions"><button class="ghost-button" data-report-status="dismissed">Dismiss</button><button class="ghost-button" data-report-status="resolved">Resolve</button><button class="primary-button" data-report-suspend> Suspend account </button><button class="danger-button" data-report-ban>Ban account</button></div></article>`).join(''):'<p class="empty-state">No open user reports.</p>';
      list.querySelectorAll('[data-report-status]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-report]');const {error}=await supabase.rpc('admin_update_report',{p_report_id:Number(card.dataset.report),p_status:btn.dataset.reportStatus,p_note:card.querySelector('[data-report-note]').value||null});if(error)alert(error.message);else await loadReports();});
      list.querySelectorAll('[data-report-suspend],[data-report-ban]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-report]');await openAccountStatusModal(card.dataset.reportedUserId,btn.hasAttribute('data-report-ban')?'banned':'suspended',Number(card.dataset.report));});
    };
    const loadFeedback=async()=>{const list=$('[data-admin-feedback]');const {data,error}=await supabase.from('feedback').select('id,user_id,category,message,created_at,read_at').order('created_at',{ascending:false});if(error){list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`;return;}const rows=data||[];list.innerHTML=rows.length?rows.map(f=>`<article class="admin-flag-item"><div class="feedback-item-head"><strong>${esc(f.category)}</strong><span>${new Date(f.created_at).toLocaleString()}</span></div><p>${esc(f.message)}</p><div class="feedback-actions"><button class="ghost-button" data-feedback-delete="${f.id}">Delete feedback</button></div></article>`).join(''):'<p class="empty-state">No feedback yet.</p>';list.querySelectorAll('[data-feedback-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this feedback?'))return;const {error}=await supabase.from('feedback').delete().eq('id',Number(b.dataset.feedbackDelete));if(error)alert(error.message);else await loadFeedback();});};
    async function openAccountStatusModal(targetId, preset=null, reportId=null){
      const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" type="button" data-close>×</button><p class="eyebrow">Account moderation</p><h2>Suspend or ban account</h2><div class="field"><label>Status</label><select data-status><option value="suspended">Suspended</option><option value="banned">Banned</option><option value="active">Restore active</option></select></div><div class="field"><label>Explanation to user</label><textarea rows="4" data-status-note placeholder="Explain why this action was taken."></textarea></div><div class="field"><label>Suspension end (optional)</label><input type="datetime-local" data-status-until></div><div class="modal-actions"><button class="ghost-button" data-close>Cancel</button><button class="primary-button" data-apply-status>Apply</button></div></section>`;document.body.appendChild(overlay);overlay.querySelector('[data-status]').value=preset||'suspended';overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());overlay.querySelector('[data-apply-status]').onclick=async()=>{const statusValue=overlay.querySelector('[data-status]').value;const note=overlay.querySelector('[data-status-note]').value||null;const until=overlay.querySelector('[data-status-until]').value?new Date(overlay.querySelector('[data-status-until]').value).toISOString():null;const {error}=await supabase.rpc('admin_set_account_status',{p_user_id:targetId,p_status:statusValue,p_note:note,p_until:until});if(error){alert(error.message);return;}if(reportId)await supabase.rpc('admin_update_report',{p_report_id:reportId,p_status:'resolved',p_note:note});overlay.remove();await Promise.all([loadFlags(),loadReports()]);};
    }
    $('[data-admin-refresh]')?.addEventListener('click',async()=>{await Promise.all([loadFlags(),loadReports(),loadFeedback()]);status.textContent='Admin data refreshed.';});
    $('[data-admin-scan]')?.addEventListener('click',async()=>{status.textContent='Scanning existing content…';const {error}=await supabase.rpc('admin_scan_existing_content',{p_limit:1000});if(error){status.textContent=error.message;return;}await loadFlags();status.textContent='Existing-content scan complete.';});
    $$('[data-admin-tab]').forEach(tab=>tab.onclick=()=>{$$('[data-admin-tab]').forEach(x=>x.classList.toggle('primary-button',x===tab));$$('[data-admin-tab]').forEach(x=>x.classList.toggle('ghost-button',x!==tab));$$('[data-admin-section]').forEach(sec=>sec.hidden=sec.dataset.adminSection!==tab.dataset.adminTab);});
    await Promise.all([loadFlags(),loadReports(),loadFeedback()]);
  }

  async function renderSocial() {
    if (messagePollTimer) clearInterval(messagePollTimer);
    const search = $('[data-friend-search]');
    const peopleList = $('[data-people-list]');
    if (!peopleList) return;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id,display_name,email,role,business_name')
      .eq('id', user.id)
      .single();
    if (profileError) throw profileError;

    await loadSocialData('');

    const acceptedFriends = getAcceptedFriends();
    if (!selectedFriendId || !acceptedFriends.some(friend => friend.id === selectedFriendId)) {
      selectedFriendId = acceptedFriends[0]?.id || null;
    }
    if (!selectedMealFriendId || !acceptedFriends.some(friend => friend.id === selectedMealFriendId)) {
      selectedMealFriendId = acceptedFriends[0]?.id || null;
    }

    const drawPeople = async () => {
      await loadSocialData(search?.value || '');
      renderPeople(search?.value || '');
      renderFriendsList(); renderFriendSelectors();
    };
    if (search) { let timer; search.oninput = () => { clearTimeout(timer); timer=setTimeout(()=>drawPeople().catch(console.error),220); }; }
    drawPeople();
    renderFriendsList();
    renderFriendSelectors();
    renderSharingControls(profile);
    await renderMessages();
    await renderSharedMeals(profile);
    wireSocialButtons(profile);

    messagePollTimer = setInterval(async () => {
      if (selectedFriendId) await renderMessages().catch(console.error);
      if (selectedMealFriendId) await renderSharedMeals(profile).catch(console.error);
    }, 3000);
  }

  async function loadSocialData(query='') {
    const [{ data: people, error: peopleError }, { data: connections, error: connectionsError }] = await Promise.all([
      supabase.rpc('search_people', { p_query: query || '' }),
      supabase.from('friend_connections').select('*').or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`).order('created_at', { ascending: false })
    ]);
    if (peopleError) throw peopleError;
    if (connectionsError) throw connectionsError;
    socialPeople = people || [];
    socialConnections = connections || [];
  }

  function connectionFor(personId) {
    return socialConnections.find(c =>
      (c.requester_id === user.id && c.addressee_id === personId) ||
      (c.addressee_id === user.id && c.requester_id === personId)
    );
  }

  function otherId(connection) {
    return connection.requester_id === user.id ? connection.addressee_id : connection.requester_id;
  }

  function personById(id) { return socialPeople.find(p => p.id === id); }
  function roleLabel(role) { return role === 'trainer' ? 'Personal trainer' : 'Personal'; }

  function getAcceptedFriends() {
    return socialConnections
      .filter(c => c.status === 'accepted')
      .map(c => personById(otherId(c)))
      .filter(Boolean)
      .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  }

  function renderPeople(query='') {
    const list = $('[data-people-list]'); if (!list) return;
    const q = query.trim().toLowerCase();
    const people = socialPeople.filter(p => !q || `${p.display_name} ${p.email} ${p.business_name || ''}`.toLowerCase().includes(q));
    const renderGroup = (role, title) => {
      const group = people.filter(p => p.role === role);
      return `<section class="social-category"><div class="social-category-header"><h3>${title}</h3><span>${group.length}</span></div>${group.length ? group.map(renderPersonCard).join('') : '<p class="page-copy">No matching people.</p>'}</section>`;
    };
    list.innerHTML = renderGroup('trainer','Personal trainers') + renderGroup('user','Personal');
  }

  function renderPersonCard(person) {
    const connection = connectionFor(person.id);
    let action = `<button class="ghost-button" type="button" data-add-person="${person.id}">Add friend</button>`;
    if (connection?.status === 'accepted') {
      action = `<button class="primary-button" type="button" data-select-friend="${person.id}">Open</button>`;
    } else if (connection?.status === 'pending') {
      action = connection.requester_id === user.id
        ? `<button class="ghost-button" type="button" disabled>Request sent</button>`
        : `<button class="primary-button" type="button" data-accept-request="${connection.id}" data-person-id="${person.id}">Accept</button>`;
    }
    return `<article class="friend-card"><div class="friend-top"><div class="profile-strip"><span class="avatar">${escapeHtml((person.display_name || 'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(person.display_name || 'MacroSync User')}</strong><p>${escapeHtml(person.email || 'Email unavailable')}</p>${person.business_name ? `<p>${escapeHtml(person.business_name)}</p>` : ''}</span></div><span class="role-badge ${person.role === 'trainer' ? 'trainer' : ''}">${roleLabel(person.role)}</span></div><div class="social-card-actions">${action}</div></article>`;
  }

  function renderFriendsList() {
    const list = $('[data-friend-list]'); if (!list) return;
    const friends = getAcceptedFriends();
    const renderGroup = (role, title) => {
      const group = friends.filter(p => p.role === role);
      return `<section class="social-category"><div class="social-category-header"><h3>${title}</h3><span>${group.length}</span></div>${group.length ? group.map(p => `<button class="friend-card friend-select-card${p.id === selectedFriendId ? ' selected' : ''}" type="button" data-select-friend="${p.id}"><div class="friend-top"><div class="profile-strip"><span class="avatar">${escapeHtml((p.display_name || 'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(p.display_name)}</strong><p>${escapeHtml(p.email || 'Email unavailable')}</p></span></div><span class="role-badge ${p.role === 'trainer' ? 'trainer' : ''}">${roleLabel(p.role)}</span></div></button>`).join('') : '<p class="page-copy">No friends in this category.</p>'}`;
    };
    list.innerHTML = friends.length ? renderGroup('trainer','Personal trainers') + renderGroup('user','Personal') : '<p class="page-copy">Add a friend to start messaging and sharing.</p>';
  }

  function renderFriendSelectors() {
    const friends = getAcceptedFriends();
    const messageSelect = $('[data-message-friend-select]');
    const mealSelect = $('[data-meal-friend-select]');

    const options = friends.length
      ? friends.map(friend => `<option value="${friend.id}">${escapeHtml(friend.display_name)}${friend.role === 'trainer' ? ' · Trainer' : ''}</option>`).join('')
      : '<option value="">No accepted friends</option>';

    if (messageSelect) {
      messageSelect.innerHTML = options;
      messageSelect.value = selectedFriendId || '';
      messageSelect.onchange = async () => {
        selectedFriendId = messageSelect.value || null;
        renderFriendsList();
        renderSharingControls(await getCurrentProfile());
        await renderMessages();
      };
    }

    if (mealSelect) {
      mealSelect.innerHTML = options;
      mealSelect.value = selectedMealFriendId || '';
      mealSelect.onchange = async () => {
        selectedMealFriendId = mealSelect.value || null;
        renderSharingControls(await getCurrentProfile());
        await renderSharedMeals(await getCurrentProfile());
      };
    }

    setText('[data-chat-title]', selectedFriendId ? (personById(selectedFriendId)?.display_name || 'Select a friend') : 'Select a friend');
  }

  async function getCurrentProfile() {
    const { data, error } = await supabase.from('profiles').select('id,display_name,email,role,business_name').eq('id', user.id).single();
    if (error) throw error;
    return data;
  }

  async function wireSocialButtons(profile) {
    document.querySelectorAll('[data-add-person]').forEach(btn => btn.onclick = async () => {
      const addressee_id = btn.dataset.addPerson;
      const { error } = await supabase.from('friend_connections').insert({ requester_id: user.id, addressee_id, status: 'pending', share_meals: false, requester_share_meals: false, addressee_share_meals: false });
      if (error) { alert(error.message); return; }
      await renderSocial();
    });

    document.querySelectorAll('[data-accept-request]').forEach(btn => btn.onclick = async () => {
      const { error } = await supabase.from('friend_connections').update({ status: 'accepted' }).eq('id', btn.dataset.acceptRequest).eq('addressee_id', user.id);
      if (error) { alert(error.message); return; }
      await renderSocial();
    });

    document.querySelectorAll('[data-select-friend]').forEach(btn => btn.onclick = async () => {
      selectedFriendId = btn.dataset.selectFriend;
      selectedMealFriendId = selectedMealFriendId || selectedFriendId;
      renderFriendsList();
      renderFriendSelectors();
      const currentProfile = await getCurrentProfile();
      renderSharingControls(currentProfile);
      await renderMessages();
      await renderSharedMeals(currentProfile);
    });

    if ($('[data-send-message]')) $('[data-send-message]').onclick = sendMessage;
    if ($('[data-message-text]')) $('[data-message-text]').onkeydown = e => { if (e.key === 'Enter') sendMessage(); };
  }

  async function renderMessages() {
    const thread = $('[data-message-thread]');
    if (!thread || !selectedFriendId) {
      if (thread) thread.innerHTML = '<p class="page-copy">Select a friend to view messages.</p>';
      return;
    }
    const { data, error } = await supabase.rpc('get_conversation_messages', { p_friend_id: selectedFriendId });
    if (error) throw error;
    setText('[data-chat-title]', personById(selectedFriendId)?.display_name || 'Select a friend');
    thread.innerHTML = data?.length
      ? data.map(m => `<article class="message-bubble ${m.sender_id === user.id ? 'mine' : ''}"><div>${escapeHtml(m.body)}</div><p>${new Date(m.created_at).toLocaleString()}</p>${m.sender_id === user.id ? `<button type="button" class="text-button danger-button message-delete-button" data-delete-message="${m.id}">Delete</button>` : `<button type="button" class="text-button danger-button" data-report-message="${m.id}">Report</button>`}</article>`).join('')
      : '<p class="page-copy">No messages yet.</p>';
    thread.querySelectorAll('[data-report-message]').forEach(button => { button.onclick = async () => { const reason = prompt('Why are you reporting this message?'); if (!reason?.trim()) return; const { error } = await supabase.rpc('report_message', { p_message_id: Number(button.dataset.reportMessage), p_reason: reason.trim() }); if (error) alert(error.message); else { alert('Report submitted to MacroSync administrators.'); button.disabled = true; button.textContent = 'Reported'; } }; });
    thread.querySelectorAll('[data-delete-message]').forEach(button => {
      button.onclick = async () => {
        if (!confirm('Delete this message permanently?')) return;
        const { data: deleted, error: deleteError } = await supabase.rpc('delete_message', { p_message_id: Number(button.dataset.deleteMessage) });
        if (deleteError) { alert(deleteError.message); return; }
        if (!deleted) { alert('The message could not be deleted. It may already be gone or you may not own it.'); return; }
        await renderMessages();
      };
    });
    thread.scrollTop = thread.scrollHeight;
  }

  async function sendMessage() {
    if (!selectedFriendId) { alert('Select a friend first.'); return; }
    const input = $('[data-message-text]'); const body = input?.value.trim();
    const { data: ageProfile } = await supabase.from('profiles').select('date_of_birth').eq('id', user.id).single();
    const isMinor = ageProfile?.date_of_birth ? ageInYears(ageProfile.date_of_birth) < 18 : true;
    const validation = validateMessageText(body, isMinor); if (validation) { alert(validation); return; }
    const { error } = await supabase.rpc('send_message', { p_recipient_id: selectedFriendId, p_body: body });
    if (error) { alert(error.message); return; }
    input.value = '';
    await renderMessages();
  }

  function shareMealsEnabledBy(connection, ownerId) {
    if (!connection || !ownerId) return false;
    if (connection.requester_id === ownerId) return Boolean(connection.requester_share_meals);
    if (connection.addressee_id === ownerId) return Boolean(connection.addressee_share_meals);
    return false;
  }

  async function renderSharingControls(profile) {
    const box = $('[data-sharing-controls]'); if (!box) return;
    const targetId = selectedMealFriendId || selectedFriendId;
    if (!targetId) { box.hidden = true; return; }
    const friend = personById(targetId); const connection = connectionFor(targetId);
    if (!friend || !connection || connection.status !== 'accepted') { box.hidden = true; return; }
    box.hidden = false;

    const myShare = shareMealsEnabledBy(connection, user.id);
    const friendShare = shareMealsEnabledBy(connection, friend.id);
    const trainerViewingClient = profile.role === 'trainer' && friend.role === 'user';
    const clientViewingTrainer = profile.role === 'user' && friend.role === 'trainer';

    const automaticTrainerNote = trainerViewingClient
      ? `<p class="page-copy">You can always view this client's daily food log as their personal trainer. You can also choose to share your own food log with them.</p>`
      : '';
    const mandatoryClientSharingNote = clientViewingTrainer
      ? `<div class="sharing-info"><strong>Meal sharing with your personal trainer cannot be disabled.</strong><p class="page-copy">Your daily food log is shared with your personal trainer while you are connected.</p></div>`
      : '';
    const friendStatus = friendShare
      ? `${escapeHtml(friend.display_name)} is sharing their daily food log with you.`
      : `${escapeHtml(friend.display_name)} is not currently sharing their daily food log with you.`;

    const mySharingControl = clientViewingTrainer
      ? mandatoryClientSharingNote
      : `<label class="toggle-row"><input type="checkbox" data-share-meals-toggle ${myShare ? 'checked' : ''}><span><strong>Share my daily food log with ${escapeHtml(friend.display_name)}</strong><small>You can turn your own meal sharing on or off for this friend.</small></span></label>`;

    box.innerHTML = `${automaticTrainerNote}${mySharingControl}<p class="page-copy sharing-status">${friendStatus}</p>`;
    box.querySelector('[data-share-meals-toggle]')?.addEventListener('change', toggleMealSharing);
  }

  async function toggleMealSharing(event) {
    const targetId = selectedMealFriendId || selectedFriendId;
    if (!targetId) return;
    const connection = connectionFor(targetId);
    if (!connection) return;
    const { data: currentProfile, error: profileError } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (profileError) { alert(profileError.message); event.target.checked = !event.target.checked; return; }
    const { error } = await supabase.rpc('set_meal_sharing', { connection_id: connection.id, enabled: event.target.checked });
    if (error) {
      alert(error.message);
      event.target.checked = !event.target.checked;
      return;
    }
    await loadSocialData();
    renderFriendSelectors();
    await renderSharingControls(currentProfile);
    await renderSharedMeals(currentProfile);
  }

  async function renderSharedMeals(profile) {
    const list = $('[data-shared-meal-list]');
    if (!list) return;
    const targetId = selectedMealFriendId;
    const friend = targetId ? personById(targetId) : null;
    const connection = targetId ? connectionFor(targetId) : null;
    const title = $('[data-meal-view-title]');
    const note = $('[data-meal-view-note]');

    if (!targetId || !friend || !connection || connection.status !== 'accepted') {
      if (title) title.textContent = 'Choose whose meals to view';
      if (note) note.textContent = 'Select an accepted friend. Personal trainers can always view their clients\' daily food logs; other friends only appear when that person has enabled sharing.';
      list.innerHTML = '<p class="page-copy">Select a friend to view shared meals.</p>';
      return;
    }

    if (title) title.textContent = `${friend.display_name}\'s meals`;
    const friendShare = shareMealsEnabledBy(connection, friend.id);
    const canView = (profile.role === 'trainer' && friend.role === 'user') || friendShare;
    if (!canView) {
      if (note) note.textContent = `${friend.display_name} has not enabled meal sharing with you.`;
      list.innerHTML = '<p class="page-copy">Meals are private for this friend right now.</p>';
      await renderSharingControls(profile);
      return;
    }

    if (note) note.textContent = `Showing ${friend.display_name}\'s meals for ${formatDate(selectedDate)}.`;
    const { data, error } = await supabase.from('food_entries').select('*').eq('user_id', friend.id).eq('logged_date', dateKey(selectedDate)).order('created_at');
    if (error) throw error;
    const entries = data || [];
    const totals = totalsFor(entries);
    if (!entries.length) {
      list.innerHTML = `<div class="share-preview"><strong>${escapeHtml(friend.display_name)} has no food logged for this day.</strong></div>`;
      return;
    }
    const { data: friendMeals, error: friendMealsError } = await supabase.from('meals').select('id,meal_number,name').eq('user_id', friend.id).order('meal_number');
    if (friendMealsError) throw friendMealsError;
    const mealCategories = (friendMeals || []).length
      ? friendMeals.map(meal => ({ key: meal.name, label: meal.name, id: meal.id }))
      : [...new Set(entries.map(entry => String(entry.meal || '').trim()).filter(Boolean))].map((name, index) => ({ key: name, label: name, id: `legacy-${index}` }));
    const categoryMarkup = mealCategories.map(category => {
      const categoryEntries = entries.filter(entry => String(entry.meal || '').trim().toLowerCase() === category.key.toLowerCase());
      const categoryTotals = totalsFor(categoryEntries);
      const body = categoryEntries.length
        ? categoryEntries.map(entry => `<article class="meal-card"><div><strong>${escapeHtml(entry.food_name)}</strong><p>${escapeHtml(entry.serving)}</p></div><strong>${moneyless(entry.calories)} cal</strong></article>`).join('')
        : '<p class="page-copy shared-meal-empty">No meals logged in this category.</p>';
      const stateKey = `${friend.id}:${dateKey(selectedDate)}:${category.id}`;
      const isOpen = !sharedMealCollapsed.has(stateKey);
      return `<details class="shared-meal-category" data-shared-meal-category="${category.key.toLowerCase()}" data-shared-meal-state-key="${stateKey}"${isOpen ? ' open' : ''}><summary><span><strong>${category.label}</strong><small>${categoryEntries.length} meal${categoryEntries.length === 1 ? '' : 's'} · ${moneyless(categoryTotals.calories)} cal</small></span><span class="shared-meal-chevron" aria-hidden="true">⌄</span></summary><div class="shared-meal-category-body">${body}</div></details>`;
    }).join('');
    list.innerHTML = `<div class="shared-meal-summary"><strong>${moneyless(totals.calories)} calories</strong><span>Protein ${moneyless(totals.protein)}g · Carbs ${moneyless(totals.carbs)}g · Fat ${moneyless(totals.fat)}g</span></div><div class="shared-meal-categories">${categoryMarkup}</div>`;

    // Preserve each category's collapsed state across any re-render of the shared-meal list.
    // The shared-meal viewer is refreshed in several places, so relying only on the native
    // <details> state would cause a collapsed section to pop open again.
    list.querySelectorAll('[data-shared-meal-state-key]').forEach(details => {
      details.addEventListener('toggle', () => {
        const stateKey = details.dataset.sharedMealStateKey;
        if (!stateKey) return;
        if (details.open) sharedMealCollapsed.delete(stateKey);
        else sharedMealCollapsed.add(stateKey);
      });
    });
  }

  function renderCalendar(){ const cal=$('[data-calendar-days]'); if(!cal)return; cal.innerHTML=''; for(let i=0;i<7;i++){const d=addDays(weekStart,i);const b=document.createElement('button');b.type='button';b.className='calendar-day'+(dateKey(d)===dateKey(selectedDate)?' active':'');b.innerHTML=`<span>${d.toLocaleDateString(undefined,{weekday:'short'})}</span><strong>${d.getDate()}</strong>`;b.onclick=async()=>{selectedDate=d; await renderPage();};cal.appendChild(b);} }
  function wireDateControls(){ $$('[data-prev-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,-1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-next-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-prev-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,-7);selectedDate=weekStart;await renderPage();}); $$('[data-next-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,7);selectedDate=weekStart;await renderPage();}); $$('[data-today-button]').forEach(b=>b.onclick=async()=>{selectedDate=new Date();weekStart=startOfWeek(selectedDate);await renderPage();}); }
  function setText(sel,val){ $$(sel).forEach(n=>n.textContent=val); }
  function setWidth(sel,pct){ $$(sel).forEach(n=>n.style.width=`${Math.max(0,Math.min(pct,100))}%`); }
  function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  return { init };
})();

PulsePlateApp.init();

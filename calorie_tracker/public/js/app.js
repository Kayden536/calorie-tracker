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
  let messagePollTimer;

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

  async function init() {
    try {
      supabase = await window.PulsePlate.ready;
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) { window.location.href = 'auth.html'; return; }
      user = data.session.user;
      weekStart = startOfWeek(selectedDate);
      const profile = await ensureProfile();
      wireGlobalAuth();
      if (!profile?.onboarding_complete) {
        await showOnboarding(profile);
        return;
      }
      await renderPage();
    } catch (error) {
      console.error(error);
      document.body.insertAdjacentHTML('afterbegin', `<div class="alpha-error">MacroSync could not initialize. ${escapeHtml(error.message)}</div>`);
    }
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
          <button type="button" data-notifications>Notifications <span class="menu-badge" data-menu-notification-count hidden>0</span></button>
          <button type="button" data-message-notification-settings>Message notifications <span data-message-notification-state>On</span></button>
          <button type="button" data-theme-toggle>Light mode</button>
          <button type="button" data-change-email>Change email</button>
          <a href="account.html">Account</a>
          <a href="goals.html">Goals</a>
          <a href="social.html">Friends & messages</a>
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
    $('[data-change-email]')?.addEventListener('click', () => { closeMenu(); showEmailChangeModal(); });
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
    if (page === 'goals') await renderGoals();
    if (page === 'progress') await renderProgress();
    if (page === 'recipes') await renderRecipes();
    if (page === 'social') await renderSocial();
    wireDateControls();
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
    renderCalendar();
  }

  function totalsFor(entries) { return entries.reduce((t,e)=>({calories:t.calories+Number(e.calories||0),protein:t.protein+Number(e.protein||0),carbs:t.carbs+Number(e.carbs||0),fat:t.fat+Number(e.fat||0)}),{calories:0,protein:0,carbs:0,fat:0}); }

  async function renderMeals(entries) {
    const list = $('[data-meal-list]'); if (!list) return;
    const mealOrder = ['Breakfast','Lunch','Dinner','Snack'];
    const grouped = mealOrder.map(meal => ({ meal, items: entries.filter(e => e.meal === meal) }));
    list.innerHTML = grouped.map(group => {
      const calories = group.items.reduce((sum, e) => sum + Number(e.calories || 0), 0);
      const isOpen = false;
      return `<details class="meal-group ${group.meal.toLowerCase()}" ${isOpen ? 'open' : ''}>
        <summary class="meal-group-header">
          <span class="meal-group-title"><span class="meal-chevron" aria-hidden="true">›</span><span><strong>${group.meal}</strong><small>${group.items.length ? `${group.items.length} item${group.items.length === 1 ? '' : 's'}` : 'No foods logged'}</small></span></span>
          <span class="meal-group-total">${moneyless(calories)} cal</span>
        </summary>
        <div class="meal-group-body">
          ${group.items.length ? group.items.map(e => `<article class="meal-item">
            <div class="meal-item-main"><strong>${escapeHtml(e.food_name)}</strong><span>${escapeHtml(e.serving)}</span></div>
            <div class="meal-item-nutrition"><strong>${moneyless(e.calories)} cal</strong><span>P ${moneyless(e.protein)}g</span><span>C ${moneyless(e.carbs)}g</span><span>F ${moneyless(e.fat)}g</span></div>
          </article>`).join('') : '<p class="meal-empty-copy">No foods logged yet.</p>'}
          <div class="meal-group-actions"><a class="meal-add-link" href="log_food.html">+ Add to ${group.meal}</a>${group.items.length ? `<button class="text-button" type="button" data-save-current-meal="${group.meal}">Save this meal</button>` : ''}</div>
        </div>
      </details>`;
    }).join('');
    list.querySelectorAll('[data-save-current-meal]').forEach(button => button.addEventListener('click', () => saveCurrentMealAsSaved(button.dataset.saveCurrentMeal)));
  }

  async function renderFoodLogger() {
    renderCalendar();
    const search = $('[data-food-search]');
    const list = $('[data-food-database-list]');
    if (!search || !list) return;

    await renderPersonalFoods();
    await renderSavedMeals();

    const run = async () => {
      const q = search.value.trim();
      if (q.length < 2) {
        list.innerHTML = '<p class="page-copy">Type at least two characters to search USDA FoodData Central.</p>';
        return;
      }
      list.innerHTML = '<p class="page-copy">Searching USDA FoodData Central…</p>';
      try {
        const response = await fetch(`/api/foods/search?q=${encodeURIComponent(q)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Food search failed.');
        const foods = Array.isArray(data.foods) ? data.foods : [];
        list.innerHTML = foods.length
          ? `<p class="food-search-count">Showing ${foods.length} result${foods.length === 1 ? '' : 's'}${data.totalHits ? ` of ${Number(data.totalHits).toLocaleString()}` : ''}.</p>${foods.map(foodCard).join('')}`
          : '<p class="page-copy">No matching foods found. If it is not in the database, use Create Manual Food below.</p>';
        $$('.food-db-card').forEach(card => card.addEventListener('click', () => {
          const food = foods.find(f => String(f.id) === card.dataset.id);
          if (food) openServingModal(food, 'usda');
        }));
      } catch (error) {
        console.error(error);
        list.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`;
      }
    };

    search.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(run, 350);
    };

    $('[data-manual-toggle]')?.addEventListener('click', () => openManualFoodModal());
    $('[data-save-food]')?.addEventListener('click', saveManualFoodAndLog);
    $$('[data-refresh-personal-foods]').forEach(b => b.addEventListener('click', renderPersonalFoods));
    await renderSelectedDateEntries();
  }

  function foodCard(food) {
    const n = food.nutrients || {};
    const serving = food.servingSize ? `${moneyless(food.servingSize)}${food.servingUnit ? ` ${escapeHtml(food.servingUnit)}` : ''}` : '100 g';
    const brand = food.brand ? escapeHtml(food.brand) : escapeHtml(food.dataType || 'USDA FoodData Central');
    return `<button type="button" class="food-db-card" data-id="${food.id}">
      <strong>${escapeHtml(food.name)}</strong>
      <p>${brand} · ${serving}</p>
      <div class="macro-row"><span>${moneyless(n.calories)} cal</span><span>${moneyless(n.protein)}g protein</span><span>${moneyless(n.carbs)}g carbs</span><span>${moneyless(n.fat)}g fat</span></div>
    </button>`;
  }

  function personalFoodCard(food) {
    return `<button type="button" class="food-db-card personal-food-card" data-personal-food-id="${food.id}">
      <strong>${escapeHtml(food.name)}</strong>
      <p>My Food · ${moneyless(food.serving_amount)} ${escapeHtml(food.serving_unit)}</p>
      <div class="macro-row"><span>${moneyless(food.calories)} cal</span><span>${moneyless(food.protein)}g protein</span><span>${moneyless(food.carbs)}g carbs</span><span>${moneyless(food.fat)}g fat</span></div>
    </button>`;
  }

  async function renderPersonalFoods() {
    const box = $('[data-personal-food-list]');
    if (!box) return;
    const { data, error } = await supabase.from('user_foods').select('*').eq('user_id', user.id).order('name');
    if (error) { box.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; return; }
    const foods = data || [];
    box.innerHTML = foods.length ? foods.map(personalFoodCard).join('') : '<p class="page-copy">You have not created any personal foods yet.</p>';
    box.querySelectorAll('[data-personal-food-id]').forEach(card => card.addEventListener('click', () => {
      const food = foods.find(f => String(f.id) === card.dataset.personalFoodId);
      if (food) openServingModal(food, 'personal');
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
    const n = source === 'personal' ? { calories:Number(food.calories)||0, protein:Number(food.protein)||0, carbs:Number(food.carbs)||0, fat:Number(food.fat)||0 } : (food.nutrients || {});
    const baseGrams = source === 'personal' ? (food.serving_unit?.toLowerCase().includes('g') ? Number(food.serving_amount) : 100) : (Number(food.servingSize) || 100);
    const defaultAmount = source === 'personal' ? Number(food.serving_amount || 1) : Number(food.servingSize || 100);
    const defaultUnit = source === 'personal' ? (food.serving_unit || 'serving') : (food.servingUnit || 'g');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card serving-modal" role="dialog" aria-modal="true" aria-labelledby="servingTitle">
      <button class="modal-close" type="button" data-close-modal aria-label="Close">×</button>
      <p class="eyebrow">${source === 'personal' ? 'My Food' : 'USDA Food'}</p><h2 id="servingTitle">${escapeHtml(food.name)}</h2>
      <div class="form-grid serving-controls">
        <div class="field"><label for="servingAmount">Amount</label><input id="servingAmount" type="number" min="0.01" step="0.01" value="${defaultAmount}"></div>
        <div class="field"><label for="servingUnit">Serving type</label><select id="servingUnit"><option value="serving" ${defaultUnit.toLowerCase().includes('serv')?'selected':''}>serving${source==='usda' && food.householdServing ? ` (${escapeHtml(food.householdServing)})` : ''}</option><option value="g" ${defaultUnit.toLowerCase().includes('g')?'selected':''}>grams</option><option value="oz">ounces</option></select></div>
        <div class="field"><label for="servingMeal">Add to meal</label><select id="servingMeal"><option value="Breakfast">Breakfast</option><option value="Lunch">Lunch</option><option value="Dinner">Dinner</option><option value="Snack">Snack</option></select></div>
      </div>
      <p class="serving-help">Nutrition updates automatically as you change the amount or serving type.</p>
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
      else if (source === 'usda') multiplier = amount * (Number(food.servingSize || 100) / baseGrams);
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
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" type="button" data-close-modal>×</button><p class="eyebrow">Personal database</p><h2>Create manual food</h2><p class="page-copy">Use this when the food cannot be found in the existing database. It will be saved to your personal foods for reuse.</p>
      <div class="form-grid"><div class="field"><label>Name</label><input data-manual-name placeholder="Homemade burrito"></div><div class="field"><label>Serving amount</label><input data-manual-serving type="number" min="0.01" step="0.01" value="1"></div><div class="field"><label>Serving type</label><input data-manual-unit value="serving" placeholder="serving, g, cup..."></div><div class="field"><label>Calories</label><input data-manual-cal type="number" min="0" step="0.1"></div><div class="field"><label>Protein (g)</label><input data-manual-protein type="number" min="0" step="0.1"></div><div class="field"><label>Carbs (g)</label><input data-manual-carbs type="number" min="0" step="0.1"></div><div class="field"><label>Fat (g)</label><input data-manual-fat type="number" min="0" step="0.1"></div></div>
      <div class="modal-actions"><button class="ghost-button" data-close-modal type="button">Cancel</button><button class="primary-button" data-save-manual type="button">Save food & add to meal</button></div><p class="save-status" data-manual-status></p></section>`;
    document.body.appendChild(overlay); overlay.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-save-manual]').onclick=async()=>{
      const name=overlay.querySelector('[data-manual-name]').value.trim(); if(!name){overlay.querySelector('[data-manual-status]').textContent='Enter a food name.';return;}
      const row={user_id:user.id,name,serving_amount:Number(overlay.querySelector('[data-manual-serving]').value)||1,serving_unit:overlay.querySelector('[data-manual-unit]').value.trim()||'serving',calories:Number(overlay.querySelector('[data-manual-cal]').value)||0,protein:Number(overlay.querySelector('[data-manual-protein]').value)||0,carbs:Number(overlay.querySelector('[data-manual-carbs]').value)||0,fat:Number(overlay.querySelector('[data-manual-fat]').value)||0,source:'manual'};
      const {data,error}=await supabase.from('user_foods').insert(row).select('*').single(); if(error){overlay.querySelector('[data-manual-status]').textContent=error.message;return;}
      overlay.remove(); await renderPersonalFoods(); openServingModal(data,'personal');
    };
  }

  async function saveManualFoodAndLog() { openManualFoodModal(); }

  async function logSavedMeal(meal) {
    const mealName = prompt(`Which meal should receive ${meal.name}?`, 'Breakfast');
    if (!mealName || !['Breakfast','Lunch','Dinner','Snack'].includes(mealName)) return;
    const items = (meal.saved_meal_items || []).map(item => ({ user_id:user.id, logged_date:dateKey(selectedDate), meal:mealName, food_name:item.food_name, serving:item.serving, fdc_id:item.fdc_id, calories:item.calories, protein:item.protein, carbs:item.carbs, fat:item.fat }));
    if (!items.length) return;
    const { error } = await supabase.from('food_entries').insert(items); if(error){alert(error.message);return;}
    await renderSelectedDateEntries();
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
    const entries=await getEntries(); const totals=totalsFor(entries); const goals=await getGoals();
    setText('[data-progress-items]', entries.length);
    setText('[data-progress-calories]', Math.round(totals.calories).toLocaleString());
    setWidth('[data-progress-bar]', totals.calories/goals.calorie_goal*100);
    setText('.card-note', `Today: ${Math.round(totals.calories).toLocaleString()} of ${goals.calorie_goal.toLocaleString()} calories logged.`);
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
    search?.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{const q=search.value.trim();if(q.length<2){results.innerHTML='';return;}results.innerHTML='<p class="page-copy">Searching…</p>';try{const r=await fetch(`/api/foods/search?q=${encodeURIComponent(q)}`);const d=await r.json();if(!r.ok)throw new Error(d.error||'Search failed');results.innerHTML=(d.foods||[]).slice(0,8).map(f=>`<button type="button" class="food-db-card" data-recipe-food-id="${f.id}"><strong>${escapeHtml(f.name)}</strong><p>${escapeHtml(f.brand||f.dataType||'USDA')}</p></button>`).join('')||'<p class="page-copy">No foods found.</p>';results.querySelectorAll('[data-recipe-food-id]').forEach(b=>b.onclick=()=>{const f=(d.foods||[]).find(x=>String(x.id)===b.dataset.recipeFoodId);if(!f)return;const n=f.nutrients||{};const amount=Number(f.servingSize||100);const unit=f.servingUnit||'g';const qty=Number(prompt(`How many ${unit} of ${f.name}?`,amount));if(!qty||qty<=0)return;const factor=qty/amount;ingredients.push({name:f.name,amount:qty,unit,fdc_id:f.id,calories:Number(n.calories||0)*factor,protein:Number(n.protein||0)*factor,carbs:Number(n.carbs||0)*factor,fat:Number(n.fat||0)*factor});drawIngredients();});}catch(e){results.innerHTML=`<p class="page-copy">${escapeHtml(e.message)}</p>`}},350)});
    builder.querySelector('[data-save-recipe]')?.addEventListener('click',async()=>{const name=builder.querySelector('[data-recipe-name]').value.trim();const servings=Math.max(1,Number(builder.querySelector('[data-recipe-servings]').value)||1);if(!name||!ingredients.length){alert('Enter a recipe name and add at least one ingredient.');return;}const {data:recipe,error}=await supabase.from('recipes').insert({user_id:user.id,name,servings}).select('*').single();if(error){alert(error.message);return;}const rows=ingredients.map(i=>({recipe_id:recipe.id,user_id:user.id,food_name:i.name,serving:`${moneyless(i.amount)} ${i.unit}`,fdc_id:i.fdc_id,calories:i.calories,protein:i.protein,carbs:i.carbs,fat:i.fat}));const {error:itemError}=await supabase.from('recipe_items').insert(rows);if(itemError){alert(itemError.message);return;}ingredients=[];builder.querySelector('[data-recipe-name]').value='';drawIngredients();await loadRecipes(list);alert(`${name} was saved.`);});
  }

  async function loadRecipes(list){
    const {data,error}=await supabase.from('recipes').select('*, recipe_items(*)').eq('user_id',user.id).order('name');
    if(error){list.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
    const recipes=data||[];list.innerHTML=recipes.length?recipes.map(r=>{const items=r.recipe_items||[];const t=items.reduce((a,i)=>({calories:a.calories+Number(i.calories||0),protein:a.protein+Number(i.protein||0),carbs:a.carbs+Number(i.carbs||0),fat:a.fat+Number(i.fat||0)}),{calories:0,protein:0,carbs:0,fat:0});return `<article class="recipe-card"><div><h2>${escapeHtml(r.name)}</h2><p>${items.length} ingredient${items.length===1?'':'s'} · ${moneyless(t.calories/Number(r.servings||1))} cal per serving</p><div class="macro-row"><span>P ${moneyless(t.protein/Number(r.servings||1))}g</span><span>C ${moneyless(t.carbs/Number(r.servings||1))}g</span><span>F ${moneyless(t.fat/Number(r.servings||1))}g</span></div></div><button class="primary-button" type="button" data-use-recipe="${r.id}">Use recipe</button></article>`}).join(''):'<p class="page-copy">No recipes yet. Create your first reusable recipe above.</p>';
    list.querySelectorAll('[data-use-recipe]').forEach(b=>b.onclick=()=>openRecipeLogModal(recipes.find(r=>String(r.id)===b.dataset.useRecipe)));
  }

  function openRecipeLogModal(recipe){
    const items=recipe?.recipe_items||[];if(!recipe||!items.length)return;const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close-modal type="button">×</button><p class="eyebrow">Recipe</p><h2>${escapeHtml(recipe.name)}</h2><div class="form-grid"><div class="field"><label>Servings</label><input data-recipe-log-amount type="number" min="0.25" step="0.25" value="1"></div><div class="field"><label>Meal</label><select data-recipe-log-meal><option>Breakfast</option><option>Lunch</option><option>Dinner</option><option>Snack</option></select></div></div><div data-recipe-log-preview class="nutrition-summary"></div><div class="modal-actions"><button class="ghost-button" data-close-modal type="button">Cancel</button><button class="primary-button" data-confirm-recipe type="button">Add to meal</button></div></section>`;document.body.appendChild(overlay);overlay.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>overlay.remove());const amount=overlay.querySelector('[data-recipe-log-amount]');const preview=overlay.querySelector('[data-recipe-log-preview]');const total=items.reduce((a,i)=>({calories:a.calories+Number(i.calories||0),protein:a.protein+Number(i.protein||0),carbs:a.carbs+Number(i.carbs||0),fat:a.fat+Number(i.fat||0)}),{calories:0,protein:0,carbs:0,fat:0});const per={calories:total.calories/Number(recipe.servings||1),protein:total.protein/Number(recipe.servings||1),carbs:total.carbs/Number(recipe.servings||1),fat:total.fat/Number(recipe.servings||1)};const calc=()=>{const x=Number(amount.value)||1;preview.innerHTML=`<div><strong>${moneyless(per.calories*x)}</strong><span>Calories</span></div><div><strong>${moneyless(per.protein*x)}g</strong><span>Protein</span></div><div><strong>${moneyless(per.carbs*x)}g</strong><span>Carbs</span></div><div><strong>${moneyless(per.fat*x)}g</strong><span>Fat</span></div>`};amount.oninput=calc;calc();overlay.querySelector('[data-confirm-recipe]').onclick=async()=>{const x=Number(amount.value)||1;const meal=overlay.querySelector('[data-recipe-log-meal]').value;const row={user_id:user.id,logged_date:dateKey(selectedDate),meal,food_name:recipe.name,serving:`${moneyless(x)} serving${x===1?'':'s'}`,fdc_id:null,calories:per.calories*x,protein:per.protein*x,carbs:per.carbs*x,fat:per.fat*x};const {error}=await supabase.from('food_entries').insert(row);if(error){alert(error.message);return;}overlay.remove();await renderSelectedDateEntries();};
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

    await loadSocialData();

    const acceptedFriends = getAcceptedFriends();
    if (!selectedFriendId || !acceptedFriends.some(friend => friend.id === selectedFriendId)) {
      selectedFriendId = acceptedFriends[0]?.id || null;
    }
    if (!selectedMealFriendId || !acceptedFriends.some(friend => friend.id === selectedMealFriendId)) {
      selectedMealFriendId = acceptedFriends[0]?.id || null;
    }

    const drawPeople = () => renderPeople(search?.value || '');
    if (search) search.oninput = drawPeople;
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

  async function loadSocialData() {
    const [{ data: people, error: peopleError }, { data: connections, error: connectionsError }] = await Promise.all([
      supabase.from('profiles').select('id,display_name,email,role,business_name').neq('id', user.id).order('display_name'),
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
      const { error } = await supabase.from('friend_connections').insert({ requester_id: user.id, addressee_id, status: 'pending', share_meals: false });
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
    const { data, error } = await supabase.from('messages').select('*')
      .or(`and(sender_id.eq.${user.id},recipient_id.eq.${selectedFriendId}),and(sender_id.eq.${selectedFriendId},recipient_id.eq.${user.id})`)
      .order('created_at');
    if (error) throw error;
    setText('[data-chat-title]', personById(selectedFriendId)?.display_name || 'Select a friend');
    thread.innerHTML = data?.length
      ? data.map(m => `<article class="message-bubble ${m.sender_id === user.id ? 'mine' : ''}"><div>${escapeHtml(m.body)}</div><p>${new Date(m.created_at).toLocaleString()}</p></article>`).join('')
      : '<p class="page-copy">No messages yet.</p>';
    thread.scrollTop = thread.scrollHeight;
  }

  async function sendMessage() {
    if (!selectedFriendId) { alert('Select a friend first.'); return; }
    const input = $('[data-message-text]'); const body = input?.value.trim(); if (!body) return;
    const { error } = await supabase.rpc('send_message', { p_recipient_id: selectedFriendId, p_body: body });
    if (error) { alert(error.message); return; }
    input.value = '';
    await renderMessages();
  }

  async function renderSharingControls(profile) {
    const box = $('[data-sharing-controls]'); if (!box) return;
    const targetId = selectedMealFriendId || selectedFriendId;
    if (!targetId) { box.hidden = true; return; }
    const friend = personById(targetId); const connection = connectionFor(targetId);
    if (!friend || !connection || connection.status !== 'accepted') { box.hidden = true; return; }
    box.hidden = false;
    const trainerAuto = profile.role === 'trainer' && friend.role === 'user';
    const userViewingTrainer = profile.role === 'user' && friend.role === 'trainer';
    if (trainerAuto) {
      box.innerHTML = '<strong>Client sharing</strong><p class="page-copy">This client\'s daily food log is automatically visible to you as their personal trainer.</p>';
    } else if (userViewingTrainer) {
      box.innerHTML = '<strong>Trainer sharing</strong><p class="page-copy">Your daily food log is automatically visible to this personal trainer while you are connected. This cannot be turned off for trainers.</p>';
    } else {
      box.innerHTML = `<label class="toggle-row"><input type="checkbox" data-share-meals-toggle ${connection.share_meals ? 'checked' : ''}><span><strong>Share my daily food log with ${escapeHtml(friend.display_name)}</strong><small>You can turn this on or off for this friend.</small></span></label>`;
      box.querySelector('[data-share-meals-toggle]')?.addEventListener('change', toggleMealSharing);
    }
  }

  async function toggleMealSharing(event) {
    const targetId = selectedMealFriendId || selectedFriendId;
    if (!targetId) return;
    const connection = connectionFor(targetId);
    if (!connection) return;
    const { data: currentProfile, error: profileError } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (profileError) { alert(profileError.message); event.target.checked = !event.target.checked; return; }
    const friend = personById(targetId);
    if (currentProfile.role === 'user' && friend?.role === 'trainer') {
      event.target.checked = true;
      alert('Meals shared with a personal trainer cannot be turned off.');
      return;
    }
    const { error } = await supabase.rpc('set_meal_sharing', { connection_id: connection.id, enabled: event.target.checked });
    if (error) {
      alert(error.message);
      event.target.checked = !event.target.checked;
      return;
    }
    await loadSocialData();
    renderFriendSelectors();
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
    const canView = profile.role === 'trainer' && friend.role === 'user' || profile.role === 'user' && friend.role === 'trainer' || connection.share_meals;
    if (!canView) {
      if (note) note.textContent = `${friend.display_name} has not enabled meal sharing with you.`;
      list.innerHTML = '<p class="page-copy">Meals are private for this friend right now.</p>';
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
    list.innerHTML = `<div class="shared-meal-summary"><strong>${moneyless(totals.calories)} calories</strong><span>Protein ${moneyless(totals.protein)}g · Carbs ${moneyless(totals.carbs)}g · Fat ${moneyless(totals.fat)}g</span></div>${entries.map(entry => `<article class="meal-card"><div><strong>${escapeHtml(entry.food_name)}</strong><p>${escapeHtml(entry.meal)} · ${escapeHtml(entry.serving)}</p></div><strong>${moneyless(entry.calories)} cal</strong></article>`).join('')}`;
  }

  function renderCalendar(){ const cal=$('[data-calendar-days]'); if(!cal)return; cal.innerHTML=''; for(let i=0;i<7;i++){const d=addDays(weekStart,i);const b=document.createElement('button');b.type='button';b.className='calendar-day'+(dateKey(d)===dateKey(selectedDate)?' active':'');b.innerHTML=`<span>${d.toLocaleDateString(undefined,{weekday:'short'})}</span><strong>${d.getDate()}</strong>`;b.onclick=async()=>{selectedDate=d; await renderPage();};cal.appendChild(b);} }
  function wireDateControls(){ $$('[data-prev-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,-1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-next-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-prev-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,-7);selectedDate=weekStart;await renderPage();}); $$('[data-next-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,7);selectedDate=weekStart;await renderPage();}); $$('[data-today-button]').forEach(b=>b.onclick=async()=>{selectedDate=new Date();weekStart=startOfWeek(selectedDate);await renderPage();}); }
  function setText(sel,val){ $$(sel).forEach(n=>n.textContent=val); }
  function setWidth(sel,pct){ $$(sel).forEach(n=>n.style.width=`${Math.max(0,Math.min(pct,100))}%`); }
  function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  return { init };
})();

PulsePlateApp.init();

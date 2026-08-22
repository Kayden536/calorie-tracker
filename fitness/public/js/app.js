const PulsePlateApp = (() => {
  let supabase;
  let user;
  let selectedDate = new Date();
  let weekStart;
  let selectedFood = null;
  let searchTimer;
  let selectedFriendId = null;
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
      document.body.insertAdjacentHTML('afterbegin', `<div class="alpha-error">PulsePlate could not initialize. ${escapeHtml(error.message)}</div>`);
    }
  }

  async function ensureProfile() {
    const displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'PulsePlate User';
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
        <h1 id="onboardingTitle">Welcome to PulsePlate</h1>
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
              <label class="choice-card"><input type="radio" name="role" value="user" checked><span>No, I'm using PulsePlate for myself</span></label>
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
      const profilePayload = { id:user.id, display_name:profile?.display_name || user.user_metadata?.display_name || user.email?.split('@')[0] || 'PulsePlate User', role, business_name:role==='trainer' ? overlay.querySelector('#onboardBusiness').value.trim() || null : null, primary_goal:primaryGoal, onboarding_complete:true };
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
    if (topbar && !$('#alphaAccountBar')) {
      const bar = document.createElement('div');
      bar.id = 'alphaAccountBar';
      bar.className = 'alpha-account-bar';
      bar.innerHTML = `<span>${escapeHtml(user.email || '')}</span><button type="button" data-logout>Log out</button>`;
      topbar.appendChild(bar);
    }
    $('[data-logout]')?.addEventListener('click', async () => { await supabase.auth.signOut(); window.location.href='auth.html'; });
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
          <a class="meal-add-link" href="log_food.html">+ Add to ${group.meal}</a>
        </div>
      </details>`;
    }).join('');
  }

  async function renderFoodLogger() {
    renderCalendar();
    const search = $('[data-food-search]');
    if (!search) return;
    const run = async () => {
      const q = search.value.trim();
      const list = $('[data-food-database-list]');
      if (q.length < 2) { list.innerHTML = '<p class="page-copy">Type at least two characters to search USDA FoodData Central.</p>'; return; }
      list.innerHTML = '<p class="page-copy">Searching…</p>';
      try {
        const response = await fetch(`/api/foods/search?q=${encodeURIComponent(q)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Food search failed.');
        list.innerHTML = data.foods.length ? data.foods.map(foodCard).join('') : '<p class="page-copy">No matching foods found.</p>';
        $$('.food-db-card').forEach(card => card.addEventListener('click', () => selectFood(data.foods.find(f=>String(f.id)===card.dataset.id))));
      } catch (error) { list.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; }
    };
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer=setTimeout(run,350); });
    $('[data-save-food]')?.addEventListener('click', saveFood);
    if (search.value) run();
    await renderSelectedDateEntries();
  }

  function foodCard(food) {
    const n=food.nutrients||{};
    return `<button type="button" class="food-db-card" data-id="${food.id}"><strong>${escapeHtml(food.name)}</strong><p>${escapeHtml(food.brand || food.dataType || 'USDA FoodData Central')}</p><div class="macro-row"><span>${moneyless(n.calories)} cal</span><span>${moneyless(n.protein)}g protein</span><span>${moneyless(n.carbs)}g carbs</span><span>${moneyless(n.fat)}g fat</span></div></button>`;
  }

  function selectFood(food) {
    selectedFood=food;
    $$('.food-db-card').forEach(c=>c.classList.toggle('selected', c.dataset.id===String(food.id)));
    $('[data-food-name]').value=food.name;
    $('[data-serving-name]').value=food.servingSize ? `${food.servingSize}${food.servingUnit?' '+food.servingUnit:''}` : '100 g';
    const n=food.nutrients||{};
    $('[data-calories-input]').value=moneyless(n.calories);
    $('[data-protein-input]').value=moneyless(n.protein);
    $('[data-carbs-input]').value=moneyless(n.carbs);
    $('[data-fat-input]').value=moneyless(n.fat);
    $('[data-form-mode-note]').textContent='USDA food selected. Nutrition values will be saved with this diary entry.';
  }

  async function saveFood() {
    const foodName=$('[data-food-name]')?.value.trim();
    const meal=$('[data-meal-name]')?.value;
    if(!foodName){alert('Choose a food first.');return;}
    if(!meal){alert('Choose Breakfast, Lunch, Dinner, or Snack before saving.');return;}
    const payload={user_id:user.id,logged_date:dateKey(selectedDate),meal,food_name:foodName,serving:$('[data-serving-name]').value.trim()||'1 serving',fdc_id:selectedFood?.id?Number(selectedFood.id):null,calories:Number($('[data-calories-input]').value)||0,protein:Number($('[data-protein-input]').value)||0,carbs:Number($('[data-carbs-input]').value)||0,fat:Number($('[data-fat-input]').value)||0};
    const {error}=await supabase.from('food_entries').insert(payload);
    $('[data-save-status]').textContent=error?error.message:`${foodName} saved.`;
    if(!error){ selectedFood=null; await renderSelectedDateEntries(); if(location.pathname.endsWith('log_food.html')) await renderFoodLogger(); }
  }

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
      const name=$('#accountName').value.trim()||'PulsePlate User';
      const role=$('.account-type button.active')?.dataset.accountRole || 'user';
      const business=role==='trainer' ? $('#businessName').value.trim() || null : null;
      const {error}=await supabase.from('profiles').update({display_name:name,role,business_name:business}).eq('id',user.id);
      const old=button.parentElement.querySelector('.save-status'); old?.remove();
      const status=document.createElement('p'); status.className='save-status'; status.textContent=error?error.message:'Profile saved.'; button.parentElement.appendChild(status);
    };
    const list=$('[data-account-list]');
    if(list) list.innerHTML=`<div class="account-card selected"><div class="account-top"><div class="profile-strip"><span class="avatar">${escapeHtml((profile?.display_name||'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(profile?.display_name||'PulsePlate User')}</strong><p>${profile?.role==='trainer'?'Personal trainer':'Normal user'}${profile?.business_name?' · '+escapeHtml(profile.business_name):''}</p></span></div><span class="role-badge">${profile?.role==='trainer'?'Trainer':'Alpha'}</span></div></div>`;
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
    const copy=$('.page-copy'); if(copy) copy.textContent='Recipe saving is planned for the next alpha milestone. The current cards are sample UI only.';
  }
  async function renderSocial() {
    if (messagePollTimer) clearInterval(messagePollTimer);
    const search = $('[data-friend-search]');
    const peopleList = $('[data-people-list]');
    if (!peopleList) return;
    const { data: profile, error: profileError } = await supabase.from('profiles').select('id,display_name,email,role,business_name').eq('id', user.id).single();
    if (profileError) throw profileError;
    await loadSocialData();
    const drawPeople = () => renderPeople(search?.value || '');
    search?.addEventListener('input', drawPeople);
    drawPeople();
    renderFriendsList();
    renderTrainerClients(profile?.role === 'trainer');
    wireSocialButtons(profile);
    messagePollTimer = setInterval(() => { if (selectedFriendId) renderMessages().catch(console.error); }, 3000);
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
    return socialConnections.find(c => (c.requester_id === user.id && c.addressee_id === personId) || (c.addressee_id === user.id && c.requester_id === personId));
  }

  function otherId(connection) { return connection.requester_id === user.id ? connection.addressee_id : connection.requester_id; }
  function personById(id) { return socialPeople.find(p => p.id === id); }
  function roleLabel(role) { return role === 'trainer' ? 'Personal trainer' : 'Personal'; }

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
    if (connection?.status === 'accepted') action = `<button class="primary-button" type="button" data-select-friend="${person.id}">Friends</button>`;
    else if (connection?.status === 'pending') action = connection.requester_id === user.id ? `<button class="ghost-button" type="button" disabled>Request sent</button>` : `<button class="primary-button" type="button" data-accept-request="${connection.id}" data-person-id="${person.id}">Accept</button>`;
    return `<article class="friend-card"><div class="friend-top"><div class="profile-strip"><span class="avatar">${escapeHtml((person.display_name || 'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(person.display_name || 'PulsePlate User')}</strong><p>${escapeHtml(person.email || 'Email unavailable')}</p>${person.business_name ? `<p>${escapeHtml(person.business_name)}</p>` : ''}</span></div><span class="role-badge ${person.role === 'trainer' ? 'trainer' : ''}">${roleLabel(person.role)}</span></div><div class="social-card-actions">${action}</div></article>`;
  }

  function renderFriendsList() {
    const list = $('[data-friend-list]'); if (!list) return;
    const friends = socialConnections.filter(c => c.status === 'accepted').map(c => personById(otherId(c))).filter(Boolean);
    const renderGroup = (role, title) => {
      const group = friends.filter(p => p.role === role);
      return `<section class="social-category"><div class="social-category-header"><h3>${title}</h3><span>${group.length}</span></div>${group.length ? group.map(p => `<button class="friend-card friend-select-card${p.id === selectedFriendId ? ' selected' : ''}" type="button" data-select-friend="${p.id}"><div class="friend-top"><div class="profile-strip"><span class="avatar">${escapeHtml((p.display_name || 'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(p.display_name)}</strong><p>${escapeHtml(p.email || 'Email unavailable')}</p></span></div><span class="role-badge ${p.role === 'trainer' ? 'trainer' : ''}">${roleLabel(p.role)}</span></div></button>`).join('') : '<p class="page-copy">No friends in this category.</p>'}`;
    };
    list.innerHTML = friends.length ? renderGroup('trainer','Personal trainers') + renderGroup('user','Personal') : '<p class="page-copy">Add a friend to start messaging and sharing.</p>';
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
      renderFriendsList();
      const friend = personById(selectedFriendId);
      setText('[data-chat-title]', friend ? friend.display_name : 'Select a friend');
      await renderMessages();
      renderSharingControls(profile);
    });
    $('[data-send-message]')?.addEventListener('click', sendMessage);
    $('[data-message-text]')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
  }

  async function renderMessages() {
    const thread = $('[data-message-thread]'); if (!thread || !selectedFriendId) { if(thread) thread.innerHTML='<p class="page-copy">Select a friend to view messages.</p>'; return; }
    const { data, error } = await supabase.from('messages').select('*').or(`and(sender_id.eq.${user.id},recipient_id.eq.${selectedFriendId}),and(sender_id.eq.${selectedFriendId},recipient_id.eq.${user.id})`).order('created_at');
    if (error) throw error;
    thread.innerHTML = data?.length ? data.map(m => `<article class="message-bubble ${m.sender_id === user.id ? 'mine' : ''}"><div>${escapeHtml(m.body)}</div><p>${new Date(m.created_at).toLocaleString()}</p></article>`).join('') : '<p class="page-copy">No messages yet.</p>';
    thread.scrollTop = thread.scrollHeight;
  }

  async function sendMessage() {
    if (!selectedFriendId) { alert('Select a friend first.'); return; }
    const input = $('[data-message-text]'); const body = input?.value.trim(); if (!body) return;
    const { error } = await supabase.from('messages').insert({ sender_id: user.id, recipient_id: selectedFriendId, body });
    if (error) { alert(error.message); return; }
    input.value = '';
    await renderMessages();
  }

  async function renderSharingControls(profile) {
    const box = $('[data-sharing-controls]'); if (!box || !selectedFriendId) return;
    const friend = personById(selectedFriendId); const connection = connectionFor(selectedFriendId);
    if (!friend || !connection) { box.hidden = true; return; }
    box.hidden = false;
    const trainerAuto = profile.role === 'trainer' && friend.role === 'user';
    if (trainerAuto) {
      box.innerHTML = '<strong>Trainer client sharing</strong><p class="page-copy">Because you are a personal trainer and this friend is a client, their daily food log is automatically visible to you while you are friends.</p>';
    } else if (friend.role === 'trainer' && profile.role === 'user') {
      box.innerHTML = '<strong>Trainer sharing</strong><p class="page-copy">Your daily food log is automatically visible to this personal trainer while you are friends.</p>';
    } else {
      box.innerHTML = `<label class="toggle-row"><input type="checkbox" data-share-meals-toggle ${connection.share_meals ? 'checked' : ''}><span><strong>Automatically share my daily food log</strong><small>This can be changed at any time.</small></span></label>`;
      box.querySelector('[data-share-meals-toggle]')?.addEventListener('change', toggleMealSharing);
    }
  }

  async function toggleMealSharing(event) {
    if (!selectedFriendId) return;
    const connection = connectionFor(selectedFriendId); if (!connection) return;
    const { error } = await supabase.from('friend_connections').update({ share_meals: event.target.checked }).eq('id', connection.id).or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);
    if (error) alert(error.message);
  }

  async function renderTrainerClients(isTrainer) {
    const panel = $('[data-trainer-client-panel]'); const list = $('[data-client-meal-list]'); if (!panel || !list) return;
    if (!isTrainer) { panel.classList.remove('visible'); return; }
    panel.classList.add('visible');
    const clients = socialConnections.filter(c => c.status === 'accepted').map(c => personById(otherId(c))).filter(p => p?.role === 'user');
    if (!clients.length) { list.innerHTML = '<p class="page-copy">Accepted client friends will appear here.</p>'; return; }
    const cards = await Promise.all(clients.map(async client => {
      const { data, error } = await supabase.from('food_entries').select('*').eq('user_id', client.id).eq('logged_date', dateKey(selectedDate)).order('created_at');
      if (error) throw error;
      const totals = totalsFor(data || []);
      const items = (data || []).map(e => `<li><strong>${escapeHtml(e.food_name)}</strong> — ${escapeHtml(e.meal)}, ${moneyless(e.calories)} cal, P ${moneyless(e.protein)}g, C ${moneyless(e.carbs)}g, F ${moneyless(e.fat)}g</li>`).join('');
      return `<article class="client-card"><h3><span>${escapeHtml(client.display_name)}</span><span>${moneyless(totals.calories)} cal</span></h3><p>${escapeHtml(client.email || '')}</p>${items ? `<ul>${items}</ul>` : '<p class="page-copy">No food logged for this day.</p>'}</article>`;
    }));
    list.innerHTML = cards.join('');
  }


  function renderCalendar(){ const cal=$('[data-calendar-days]'); if(!cal)return; cal.innerHTML=''; for(let i=0;i<7;i++){const d=addDays(weekStart,i);const b=document.createElement('button');b.type='button';b.className='calendar-day'+(dateKey(d)===dateKey(selectedDate)?' active':'');b.innerHTML=`<span>${d.toLocaleDateString(undefined,{weekday:'short'})}</span><strong>${d.getDate()}</strong>`;b.onclick=async()=>{selectedDate=d; await renderPage();};cal.appendChild(b);} }
  function wireDateControls(){ $$('[data-prev-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,-1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-next-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-prev-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,-7);selectedDate=weekStart;await renderPage();}); $$('[data-next-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,7);selectedDate=weekStart;await renderPage();}); $$('[data-today-button]').forEach(b=>b.onclick=async()=>{selectedDate=new Date();weekStart=startOfWeek(selectedDate);await renderPage();}); }
  function setText(sel,val){ $$(sel).forEach(n=>n.textContent=val); }
  function setWidth(sel,pct){ $$(sel).forEach(n=>n.style.width=`${Math.max(0,Math.min(pct,100))}%`); }
  function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  return { init };
})();

PulsePlateApp.init();

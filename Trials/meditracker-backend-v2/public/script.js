(function(){
  var API_BASE = 'http://localhost:4000/api';

  var field = document.getElementById('dotField');
  for(var i=0; i<72; i++){
    var d = document.createElement('div');
    if(Math.random() < 0.12){ d.className='lit'; d.style.animationDelay=(Math.random()*4.5)+'s'; }
    field.appendChild(d);
  }

  var currentEditingId = null;
  var editingMedForSchedule = null;
  var editingScheduleIdx = null;

  var medicines = [];
  var todaysDoses = [];
  var activity = [];
  var historyLogs = [];

  async function apiFetch(path, options){
    options = options || {};
    var headers = options.headers || {};
    headers['Content-Type'] = 'application/json';

    try {
      const res = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers: headers,
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      if (res.status === 204) return null;
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data && data.error) ? data.error : 'API request failed');
      }
      return data;
    } catch(err) {
      console.error('API Error:', err);
      return null;
    }
  }

  var authForm = document.getElementById('authForm');
  var loginScreen = document.getElementById('login-screen');
  var dashboard = document.getElementById('dashboard');
  var authToast = document.getElementById('authToast');
  var authMode = 'login'; 

  function setAuthMode(mode){
    authMode = mode;
    authToast.classList.remove('show');
    if(authMode === 'register'){
      document.getElementById('loginTitle').textContent = 'Create Account';
      document.getElementById('loginSub').textContent = 'Set up access for the pill box console.';
      document.getElementById('registerExtraFields').style.display = 'block';
      document.getElementById('loginSubmitBtn').textContent = 'Create Account';
      document.getElementById('authModeToggle').textContent = 'Already have an account? Sign in';
    } else {
      document.getElementById('loginTitle').textContent = 'Sign in';
      document.getElementById('loginSub').textContent = 'Enter credentials to access the pill box console.';
      document.getElementById('registerExtraFields').style.display = 'none';
      document.getElementById('loginSubmitBtn').textContent = 'Sign in';
      document.getElementById('authModeToggle').textContent = 'Need to create an account?';
    }
  }

  document.getElementById('authModeToggle').addEventListener('click', function(){
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });

  authForm.addEventListener('submit', async function(e){
    e.preventDefault();
    var userVal = document.getElementById('username').value.trim() || 'Caregiver';

    if(authMode === 'register'){
      setAuthMode('login');
      authToast.classList.add('show');
      document.getElementById('password').value = '';
    } else {
      document.getElementById('userNameLabel').textContent = userVal;
      document.getElementById('userAvatar').textContent = userVal.charAt(0).toUpperCase();
      
      loginScreen.style.display = 'none';
      dashboard.classList.add('active');
      await refreshAll();
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', function(){
    dashboard.classList.remove('active');
    loginScreen.style.display = 'grid';
    setAuthMode('login');
  });

  var navItems = document.querySelectorAll('.nav-item');
  var pages = document.querySelectorAll('.page');
  var titles = {
    overview: ['Overview', 'Snapshot of pill box status and today schedule.'],
    missed: ['Missed Doses', 'Doses scheduled that were not detected/dispensed.'],
    history: ['Compartment Log', 'Logs for refills and compartment operations.'],
    track: ['Daily Schedule', 'Real-time schedule for today.'],
    edit: ['Manage Medicines', 'Map medicines to specific pill box compartments.'],
    restock: ['Restock Refills', 'Compartments requiring pill replenishment.']
  };

  function goToPage(key){
    navItems.forEach(function(b){b.classList.remove('active');});
    var btn = document.querySelector('.nav-item[data-page="'+key+'"]');
    if(btn) btn.classList.add('active');
    
    pages.forEach(function(p){p.classList.remove('active');});
    var page = document.getElementById('page-'+key);
    if(page) page.classList.add('active');
    
    if(titles[key]){
      document.getElementById('topbarTitle').textContent = titles[key][0];
      document.getElementById('topbarDesc').textContent = titles[key][1];
    }
  }

  navItems.forEach(function(btn){
    btn.addEventListener('click', function(){ goToPage(btn.dataset.page); });
  });

  function renderOverview(){
    document.getElementById('statTotal').textContent = medicines.length;
    document.getElementById('statTaken').textContent = todaysDoses.filter(function(d){ return d.taken; }).length;
    document.getElementById('statPending').textContent = todaysDoses.filter(function(d){ return !d.taken && d.state !== 'missed'; }).length;
    document.getElementById('statMissed').textContent = todaysDoses.filter(function(d){ return d.state === 'missed'; }).length;

    var barsHtml = medicines.map(function(m){
      var total = m.pillsFull || 1;
      var current = m.pillsLeft || 0;
      var pct = Math.min(100, Math.round((current / total) * 100));
      return '<div class="bar-row">' +
        '<div class="cat">' + m.name + ' (' + m.compartment + ')</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="num">' + current + ' / ' + total + '</div>' +
      '</div>';
    }).join('');
    document.getElementById('overviewBars').innerHTML = barsHtml || '<div class="empty-note">No medicines configured in compartments.</div>';

    var movesHtml = activity.map(function(a){
      return '<div class="movement-item">' +
        '<div><span class="m-item">' + a.item + '</span> — ' + a.action + '</div>' +
        '<div style="color:var(--text-faint); font-size:11px;">' + (a.createdAt ? new Date(a.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : 'Today') + '</div>' +
      '</div>';
    }).join('');
    document.getElementById('overviewMovements').innerHTML = movesHtml || '<div class="empty-note">No recent activity.</div>';
  }

  function renderMissed(){
    var body = document.getElementById('missedTableBody');
    var missed = todaysDoses.filter(function(d){ return d.state === 'missed'; });
    document.getElementById('navMissedCount').textContent = missed.length;

    if(!missed.length){
      body.innerHTML = '<tr><td colspan="6" class="empty-note">No missed doses.</td></tr>';
      return;
    }

    body.innerHTML = missed.map(function(r){
      return '<tr>' +
        '<td><b>' + r.medicineName + '</b></td>' +
        '<td>' + r.dosage + '</td>' +
        '<td>' + r.time + '</td>' +
        '<td>' + r.compartment + '</td>' +
        '<td><span class="badge out">Missed</span></td>' +
        '<td><button class="btn-restock" onclick="window.markDoseTaken(\'' + r.scheduleId + '\')">Dispense Now</button></td>' +
      '</tr>';
    }).join('');
  }

  function renderTrack(){
    var body = document.getElementById('trackTableBody');
    document.getElementById('trackCountLabel').textContent = todaysDoses.length + ' doses';
    document.getElementById('navTrackCount').textContent = todaysDoses.length;

    if(!todaysDoses.length){
      body.innerHTML = '<tr><td colspan="6" class="empty-note">No doses scheduled for today.</td></tr>';
      return;
    }

    body.innerHTML = todaysDoses.map(function(d){
      var badgeClass = d.taken ? 'ok' : (d.state === 'missed' ? 'out' : (d.state === 'due' ? 'due' : 'upcoming'));
      var badgeLabel = d.taken ? 'Taken' : (d.state ? d.state.toUpperCase() : 'PENDING');
      var btn = d.taken 
        ? '<span style="color:var(--text-faint); font-size:12px;">✓ Dispensed</span>'
        : '<button class="btn-restock" onclick="window.markDoseTaken(\'' + d.scheduleId + '\')">Mark Dispensed</button>';

      var schedIdx = findScheduleIndex(d.medicineId, d.scheduleId);

      return '<tr>' +
        '<td><b>' + d.medicineName + '</b></td>' +
        '<td>' + d.dosage + '</td>' +
        '<td>' + d.time + '</td>' +
        '<td>' + d.compartment + '</td>' +
        '<td><span class="badge ' + badgeClass + '">' + badgeLabel + '</span></td>' +
        '<td>' +
          '<div class="action-btn-group">' +
            btn +
            '<button class="btn-icon edit-sched" onclick="window.openEditScheduleModal(\'' + d.medicineId + '\', \'' + schedIdx + '\')">✎ Edit</button>' +
            '<button class="btn-icon delete-sched" onclick="window.deleteSingleSchedule(\'' + d.medicineId + '\', \'' + schedIdx + '\')">✕</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function findScheduleIndex(medId, scheduleId){
    var med = medicines.find(function(m){ return String(m.id) === String(medId); });
    if(!med || !med.schedule) return -1;
    return med.schedule.findIndex(function(s){ return String(s.id) === String(scheduleId); });
  }

  window.markDoseTaken = async function(scheduleId){
    await apiFetch('/doses/' + scheduleId + '/taken', { method: 'POST' });
    await refreshAll();
  };

  window.openEditScheduleModal = function(medId, schedIdx){
    var med = medicines.find(function(m){ return String(m.id) === String(medId); });
    var parsedIdx = parseInt(schedIdx, 10);
    if(!med || !med.schedule || isNaN(parsedIdx) || !med.schedule[parsedIdx]) return;

    editingMedForSchedule = med;
    editingScheduleIdx = parsedIdx;

    document.getElementById('modalMedTitle').textContent = 'Edit Schedule for ' + med.name;
    var container = document.getElementById('modalScheduleContainer');
    container.innerHTML = '';
    container.appendChild(renderScheduleRow(med.schedule[editingScheduleIdx]));
    
    var removeBtn = container.querySelector('.btn-remove-time');
    if(removeBtn) removeBtn.style.display = 'none';

    document.getElementById('editScheduleModal').classList.add('active');
  };

  document.getElementById('cancelScheduleModalBtn').addEventListener('click', function(){
    document.getElementById('editScheduleModal').classList.remove('active');
    editingMedForSchedule = null;
    editingScheduleIdx = null;
  });

  document.getElementById('saveScheduleModalBtn').addEventListener('click', async function(){
    if(!editingMedForSchedule || editingScheduleIdx === null) return;

    var wrap = document.querySelector('#modalScheduleContainer .schedule-row-wrap');
    if(!wrap) return;

    var time = wrap.querySelector('.sched-time').value;
    var dosage = wrap.querySelector('.sched-dosage').value;
    var timing = wrap.querySelector('.sched-timing').value;
    var comments = wrap.querySelector('.sched-comments').value;
    var isDaily = wrap.querySelector('.daily-chip').classList.contains('active');
    var days = isDaily ? 'daily' : Array.from(wrap.querySelectorAll('.day-chip:not(.daily-chip).active')).map(function(c){ return parseInt(c.dataset.day,10); });

    var updatedSchedule = Array.from(editingMedForSchedule.schedule);
    updatedSchedule[editingScheduleIdx] = { id: editingMedForSchedule.schedule[editingScheduleIdx].id, time: time, dosage: dosage, timing: timing, comments: comments, days: days };

    var payload = {
      name: editingMedForSchedule.name,
      compartment: editingMedForSchedule.compartment,
      threshold: editingMedForSchedule.threshold,
      pillsFull: editingMedForSchedule.pillsFull,
      pillsLeft: editingMedForSchedule.pillsLeft,
      schedule: updatedSchedule
    };

    var result = await apiFetch('/medicines/' + editingMedForSchedule.id, { method: 'PUT', body: payload });
    if(result){
      document.getElementById('editScheduleModal').classList.remove('active');
      editingMedForSchedule = null;
      editingScheduleIdx = null;
      await refreshAll();
    } else {
      alert('Error saving schedule changes to the database.');
    }
  });

  window.deleteSingleSchedule = async function(medId, schedIdx){
    var med = medicines.find(function(m){ return String(m.id) === String(medId); });
    var parsedIdx = parseInt(schedIdx, 10);
    if(!med || !med.schedule || isNaN(parsedIdx) || !med.schedule[parsedIdx]) return;

    if(!confirm('Are you sure you want to delete this scheduled dose time? Medicine details and stock counts will remain intact.')) return;

    var updatedSchedule = med.schedule.filter(function(_, i){ return i !== parsedIdx; });
    if(updatedSchedule.length === 0){
      alert('A medicine needs at least one scheduled dose time. Add another time before removing this one, or delete the whole medicine instead.');
      return;
    }

    var payload = {
      name: med.name,
      compartment: med.compartment,
      threshold: med.threshold,
      pillsFull: med.pillsFull,
      pillsLeft: med.pillsLeft,
      schedule: updatedSchedule.map(function(s){
        return { id: s.id, time: s.time, dosage: s.dosage, timing: s.timing, comments: s.comments, days: s.days };
      })
    };

    var result = await apiFetch('/medicines/' + medId, { method: 'PUT', body: payload });
    if(result){
      await refreshAll();
    } else {
      alert('Error deleting schedule entry from the database.');
    }
  };

  function renderHistory(){
    var body = document.getElementById('historyTableBody');
    if(!historyLogs.length){
      body.innerHTML = '<tr><td colspan="4" class="empty-note">No log entries saved yet.</td></tr>';
      return;
    }
    body.innerHTML = historyLogs.map(function(item){
      return '<tr>'+
        '<td><b>'+item.date+'</b></td>'+
        '<td><span class="badge ok">'+item.category+'</span></td>'+
        '<td>'+item.title+'</td>'+
        '<td>'+(item.notes || '—')+'</td>'+
      '</tr>';
    }).join('');
  }

  document.getElementById('historyForm').addEventListener('submit', function(e){
    e.preventDefault();
    historyLogs.unshift({
      date: document.getElementById('historyDate').value,
      category: document.getElementById('historyCategory').value,
      title: document.getElementById('historyTitle').value,
      notes: document.getElementById('historyNotes').value
    });
    renderHistory();
    this.reset();
  });

  function renderScheduleRow(sched){
    sched = sched || { time: '08:00', dosage: '1 pill', timing: 'After Food', comments: '', days: 'daily' };
    var row = document.createElement('div');
    row.className = 'schedule-row-wrap';
    
    var daysArr = Array.isArray(sched.days) ? sched.days : [];
    var isDaily = sched.days === 'daily' || !sched.days;
    var timingVal = sched.timing || 'After Food';
    var commentsVal = sched.comments || '';

    row.innerHTML = 
      '<div class="schedule-row">' +
        '<input type="time" class="sched-time" value="' + (sched.time || '08:00') + '">' +
        '<input type="text" class="sched-dosage" placeholder="e.g. 1 pill" value="' + (sched.dosage || '1 pill') + '">' +
        '<select class="sched-timing">' +
          '<option value="Before Food" ' + (timingVal === 'Before Food' ? 'selected' : '') + '>Before Food</option>' +
          '<option value="With Food" ' + (timingVal === 'With Food' ? 'selected' : '') + '>With Food</option>' +
          '<option value="After Food" ' + (timingVal === 'After Food' ? 'selected' : '') + '>After Food</option>' +
        '</select>' +
        '<button type="button" class="btn-remove-time">✕</button>' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<input type="text" class="sched-comments" placeholder="Additional comments (e.g. take with glass of water)" value="' + commentsVal + '">' +
      '</div>' +
      '<div class="days-row">' +
        '<button type="button" class="day-chip daily-chip ' + (isDaily ? 'active' : '') + '">Daily</button>' +
        '<button type="button" class="day-chip ' + (!isDaily && daysArr.includes(1) ? 'active' : '') + '" data-day="1">M</button>' +
        '<button type="button" class="day-chip ' + (!isDaily && daysArr.includes(2) ? 'active' : '') + '" data-day="2">T</button>' +
        '<button type="button" class="day-chip ' + (!isDaily && daysArr.includes(3) ? 'active' : '') + '" data-day="3">W</button>' +
        '<button type="button" class="day-chip ' + (!isDaily && daysArr.includes(4) ? 'active' : '') + '" data-day="4">T</button>' +
        '<button type="button" class="day-chip ' + (!isDaily && daysArr.includes(5) ? 'active' : '') + '" data-day="5">F</button>' +
        '<button type="button" class="day-chip ' + (!isDaily && daysArr.includes(6) ? 'active' : '') + '" data-day="6">S</button>' +
        '<button type="button" class="day-chip ' + (!isDaily && daysArr.includes(0) ? 'active' : '') + '" data-day="0">S</button>' +
      '</div>';

    row.querySelector('.btn-remove-time').addEventListener('click', function(){ row.remove(); });

    var dailyBtn = row.querySelector('.daily-chip');
    var dayChips = row.querySelectorAll('.day-chip:not(.daily-chip)');

    dailyBtn.addEventListener('click', function(){
      dailyBtn.classList.add('active');
      dayChips.forEach(function(c){ c.classList.remove('active'); });
    });

    dayChips.forEach(function(chip){
      chip.addEventListener('click', function(){
        dailyBtn.classList.remove('active');
        chip.classList.toggle('active');
        var anyActive = Array.from(dayChips).some(function(c){ return c.classList.contains('active'); });
        if(!anyActive) dailyBtn.classList.add('active');
      });
    });

    return row;
  }

  document.getElementById('addTimeBtn').addEventListener('click', function(){
    document.getElementById('scheduleEditor').appendChild(renderScheduleRow());
  });

  function populateManageForm(med){
    var formPanel = document.getElementById('medicineFormPanel');
    
    if(!med && currentEditingId === null && formPanel.style.display === 'none') {
      return; 
    }

    if (med || currentEditingId !== null) {
      formPanel.style.display = 'block';
    }

    currentEditingId = med ? med.id : null;
    document.getElementById('editName').value = med ? med.name : '';
    document.getElementById('editCompartment').value = med ? med.compartment : '';
    document.getElementById('editThreshold').value = med ? med.threshold : 5;
    document.getElementById('editPillsFull').value = med ? med.pillsFull : 30;
    document.getElementById('editPillsLeft').value = med ? med.pillsLeft : 30;

    var editor = document.getElementById('scheduleEditor');
    editor.innerHTML = '';
    var scheduleList = (med && med.schedule && med.schedule.length) ? med.schedule : [{ time: '08:00', dosage: '1 pill', timing: 'After Food', comments: '', days: 'daily' }];
    scheduleList.forEach(function(s){ editor.appendChild(renderScheduleRow(s)); });

    document.getElementById('deleteMedBtn').style.display = med ? 'block' : 'none';
  }

  function renderEditDropdown(){
    var select = document.getElementById('editSelect');
    select.innerHTML = '<option value="">-- Select Medicine to Edit --</option>' +
      medicines.map(function(m){ return '<option value="' + m.id + '">' + m.name + ' (Compartment ' + m.compartment + ')</option>'; }).join('');
    select.value = currentEditingId || '';
  }

  document.getElementById('editSelect').addEventListener('change', function(){
    var id = this.value;
    if(!id) {
      document.getElementById('medicineFormPanel').style.display = 'none';
      currentEditingId = null;
      return;
    }
    var med = medicines.find(function(m){ return String(m.id) === String(id); });
    document.getElementById('medicineFormPanel').style.display = 'block';
    populateManageForm(med);
  });

  document.getElementById('resetEditBtn').addEventListener('click', function(){
    document.getElementById('medicineFormPanel').style.display = 'none';
    document.getElementById('editSelect').value = '';
    currentEditingId = null;
  });

  document.getElementById('newMedBtn').addEventListener('click', function(){
    goToPage('edit');
    document.getElementById('editSelect').value = '';
    currentEditingId = null;
    document.getElementById('medicineFormPanel').style.display = 'block';
    populateManageForm(null);
  });

  document.getElementById('saveEditBtn').addEventListener('click', async function(){
    var name = document.getElementById('editName').value.trim();
    var compartment = document.getElementById('editCompartment').value.trim();
    if(!name || !compartment) return alert('Name and compartment required.');

    var schedule = [];
    var existingSchedule = currentEditingId ? (medicines.find(function(m){ return String(m.id) === String(currentEditingId); }) || {}).schedule || [] : [];
    document.querySelectorAll('#scheduleEditor .schedule-row-wrap').forEach(function(wrap, idx){
      var time = wrap.querySelector('.sched-time').value;
      var dosage = wrap.querySelector('.sched-dosage').value;
      var timing = wrap.querySelector('.sched-timing').value;
      var comments = wrap.querySelector('.sched-comments').value;
      var isDaily = wrap.querySelector('.daily-chip').classList.contains('active');
      var days = isDaily ? 'daily' : Array.from(wrap.querySelectorAll('.day-chip:not(.daily-chip).active')).map(function(c){ return parseInt(c.dataset.day,10); });
      // preserve the existing row's id (by position) so the backend updates
      // it in place instead of recreating it and losing today's dose status
      var existingId = existingSchedule[idx] ? existingSchedule[idx].id : undefined;
      if(time && dosage) schedule.push({ id: existingId, time: time, dosage: dosage, timing: timing, comments: comments, days: days });
    });

    var payload = {
      name: name,
      compartment: compartment,
      threshold: parseInt(document.getElementById('editThreshold').value, 10) || 5,
      pillsFull: parseInt(document.getElementById('editPillsFull').value, 10) || 30,
      pillsLeft: parseInt(document.getElementById('editPillsLeft').value, 10) || 30,
      schedule: schedule
    };

    if(currentEditingId){
      await apiFetch('/medicines/' + currentEditingId, { method: 'PUT', body: payload });
    } else {
      await apiFetch('/medicines', { method: 'POST', body: payload });
    }

    document.getElementById('medicineFormPanel').style.display = 'none';
    currentEditingId = null;
    await refreshAll();
  });

  document.getElementById('deleteMedBtn').addEventListener('click', async function(){
    if(!currentEditingId) return;
    await apiFetch('/medicines/' + currentEditingId, { method: 'DELETE' });
    currentEditingId = null;
    document.getElementById('medicineFormPanel').style.display = 'none';
    await refreshAll();
  });

  function renderRestock(){
    var container = document.getElementById('restockList');
    var items = medicines.filter(function(m){ return m.pillsLeft <= m.threshold; });
    document.getElementById('restockCountLabel').textContent = items.length + ' items';
    document.getElementById('navRestockCount').textContent = items.length;

    if(!items.length){
      container.innerHTML = '<div class="empty-note">All compartments sufficiently stocked.</div>';
      return;
    }

    container.innerHTML = items.map(function(item){
      return '<div class="restock-card">' +
        '<div class="r-info">' +
          '<div class="r-name">' + item.name + ' (Compartment ' + item.compartment + ')</div>' +
          '<div class="r-meta">Current: ' + item.pillsLeft + ' / Threshold: ' + item.threshold + '</div>' +
        '</div>' +
        '<input type="number" value="' + item.pillsFull + '" id="restockVal_' + item.id + '">' +
        '<button class="btn-restock" onclick="window.confirmRestock(\'' + item.id + '\')">Refill</button>' +
      '</div>';
    }).join('');
  }

  window.confirmRestock = async function(id){
    var count = parseInt(document.getElementById('restockVal_' + id).value, 10);
    await apiFetch('/restock/' + id, { method: 'POST', body: { qty: count } });
    await refreshAll();
  };

  async function refreshAll(){
    const medRes = await apiFetch('/medicines');
    if (medRes) medicines = medRes;

    const doseRes = await apiFetch('/doses/today');
    if (doseRes) todaysDoses = doseRes;

    const actRes = await apiFetch('/doses/activity');
    if (actRes) activity = actRes;

    renderOverview();
    renderMissed();
    renderHistory();
    renderTrack();
    renderEditDropdown();
    renderRestock();
  }

})();

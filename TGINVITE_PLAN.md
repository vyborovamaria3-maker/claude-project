# Plan: TGInvite Integration into claude-project

## Current State Analysis

### Existing Project Structure
- **admin-site**: FastAPI control panel with sidebar navigation
- **Frontend**: HTML/CSS/JS with tab-based navigation (14 tabs)
- **Backend**: FastAPI with API endpoints
- **Telegram integration**: Already exists in telegram-miniapp

### What We Need to Add
1. New navigation item: "TGInvite" (tab 15)
2. Backend API endpoints for TGInvite functionality
3. Frontend view with smart import features
4. Integration with tgingest system

## Implementation Plan

### Phase 1: Backend API Endpoints
**File: `admin-site/app/main.py`**

Add new API endpoints:
- `POST /api/tginvite/analyze` - Analyze channel participants
- `POST /api/tginvite/import` - Start smart import
- `GET /api/tginvite/status` - Get import status
- `POST /api/tginvite/preview` - Preview users before import
- `GET /api/tginvite/history` - Import history

### Phase 2: Frontend Navigation
**File: `admin-site/app/static/index.html`**

Add to sidebar navigation:
```html
<button data-view="tginvite" class="nav-item">
  <span>15</span>TGInvite
</button>
```

### Phase 3: Frontend View
**File: `admin-site/app/static/app.js`**

Add new view function `renderTGInvite()` with:
- Channel selection (saved channels dropdown + manual input)
- Source channels management (add/remove multiple)
- File import (JSON, TXT, CSV)
- User filters (activity, quality, limits, stealth)
- Import progress with ETA
- Import history

### Phase 4: Styling
**File: `admin-site/app/static/styles.css`**

Add styles for:
- Import wizard steps
- Source channel items
- Filter tabs
- Progress bar
- Import stats cards

## Detailed Implementation Steps

### Step 1: Backend API (main.py)

```python
# Add after existing endpoints

class TGInviteAnalyzeBody(BaseModel):
    channel: str = Field(min_length=1, max_length=200)
    days: int = Field(default=30, ge=1, le=365)
    min_messages: int = Field(default=5, ge=0)

class TGInviteImportBody(BaseModel):
    target: str = Field(min_length=1, max_length=200)
    sources: list[str] = Field(min_length=1)
    limit: int = Field(default=500, ge=1, le=10000)
    batch_size: int = Field(default=50, ge=1, le=200)
    delay_ms: int = Field(default=100, ge=0, le=5000)
    filter_days: int = Field(default=30, ge=1, le=365)
    filter_min_messages: int = Field(default=5, ge=0)

@app.post("/api/tginvite/analyze")
def analyze_channel(body: TGInviteAnalyzeBody, admin=Depends(require_admin)):
    # Analyze channel participants
    pass

@app.post("/api/tginvite/import")
def start_import(body: TGInviteImportBody, admin=Depends(require_admin)):
    # Start smart import
    pass

@app.get("/api/tginvite/status")
def import_status(admin=Depends(require_admin)):
    # Get current import status
    pass

@app.get("/api/tginvite/history")
def import_history(admin=Depends(require_admin)):
    # Get import history
    pass
```

### Step 2: Frontend Navigation (index.html)

Add new button after "Аудит":
```html
<button data-view="tginvite" class="nav-item">
  <span>15</span>TGInvite
</button>
```

### Step 3: Frontend View (app.js)

```javascript
// Add to titles object
titles.tginvite = "TGInvite - Smart Import";

// Add state
state.tginvite = {
  target: '',
  sources: [],
  filterDays: 30,
  filterMinMessages: 5,
  limit: 500,
  batchSize: 50,
  delayMs: 100,
  status: null,
  history: []
};

// Add render function
async function renderTGInvite() {
  loading();
  const data = await api("/api/tginvite/status");
  
  content.innerHTML = `
    <!-- Step 1: Target Channel -->
    <section class="section">
      <div class="section-head"><h3>Step 1: Target Channel</h3></div>
      <div class="form-group">
        <label>Target Channel</label>
        <div class="form-row">
          <select id="tgi-target-select">
            <option value="">-- Select saved channel --</option>
          </select>
          <input id="tgi-target-input" placeholder="@channel or ID">
        </div>
      </div>
    </section>
    
    <!-- Step 2: Sources -->
    <section class="section">
      <div class="section-head">
        <h3>Step 2: Source Channels</h3>
        <button id="tgi-add-source" class="small-btn">+ Add</button>
      </div>
      <div id="tgi-sources-list"></div>
      <div class="form-row">
        <input id="tgi-new-source" placeholder="@channel or ID">
        <select id="tgi-source-type">
          <option value="public">Public</option>
          <option value="group">Group</option>
        </select>
      </div>
      <div class="file-import">
        <label>Import from file</label>
        <input type="file" id="tgi-file-input" accept=".json,.txt,.csv">
      </div>
    </section>
    
    <!-- Step 3: Filters -->
    <section class="section">
      <div class="section-head"><h3>Step 3: User Filters</h3></div>
      <div class="tabs">
        <button class="tab active" data-tab="activity">Activity</button>
        <button class="tab" data-tab="quality">Quality</button>
        <button class="tab" data-tab="limits">Limits</button>
        <button class="tab" data-tab="stealth">Stealth</button>
      </div>
      <div id="tgi-filters-content"></div>
    </section>
    
    <!-- Step 4: Summary -->
    <section class="section">
      <div class="section-head"><h3>Step 4: Import Summary</h3></div>
      <div id="tgi-summary"></div>
      <div class="form-row">
        <button id="tgi-preview" class="secondary">Preview Users</button>
        <button id="tgi-start" class="primary">Start Smart Import</button>
      </div>
    </section>
    
    <!-- Progress -->
    <section id="tgi-progress" class="section hidden">
      <div class="section-head"><h3>Import Progress</h3></div>
      <div id="tgi-progress-content"></div>
    </section>
    
    <!-- History -->
    <section class="section">
      <div class="section-head"><h3>Import History</h3></div>
      <div id="tgi-history"></div>
    </section>
  `;
  
  // Initialize event listeners
  setupTGInviteListeners();
  renderTGInviteSources();
  renderTGInviteFilters('activity');
  renderTGInviteSummary();
}

function setupTGInviteListeners() {
  // Add source button
  $('#tgi-add-source')?.addEventListener('click', () => {
    const input = $('#tgi-new-source');
    const source = input.value.trim();
    if (source && !state.tginvite.sources.includes(source)) {
      state.tginvite.sources.push(source);
      renderTGInviteSources();
      input.value = '';
      toast('Added ' + source);
    }
  });
  
  // File import
  $('#tgi-file-input')?.addEventListener('change', handleTGInviteFileImport);
  
  // Tabs
  document.querySelectorAll('.tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderTGInviteFilters(tab.dataset.tab);
    });
  });
  
  // Start import
  $('#tgi-start')?.addEventListener('click', startTGInviteImport);
}

// ... more functions
```

### Step 4: Styling (styles.css)

```css
/* TGInvite Styles */
.tgi-source-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--surface);
  border-radius: 8px;
  margin-bottom: 8px;
}

.tgi-source-item .remove-btn {
  color: var(--danger);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.tgi-source-item .remove-btn:hover {
  background: rgba(255, 92, 92, 0.1);
}

.tgi-filter-tab {
  padding: 16px;
  background: var(--surface);
  border-radius: 8px;
}

.tgi-progress-bar {
  height: 8px;
  background: var(--surface);
  border-radius: 4px;
  overflow: hidden;
}

.tgi-progress-bar .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), var(--accent));
  transition: width 0.3s ease;
}

.tgi-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-top: 16px;
}

.tgi-stat {
  text-align: center;
  padding: 16px;
  background: var(--surface);
  border-radius: 8px;
}

.tgi-stat .value {
  font-size: 24px;
  font-weight: bold;
  color: var(--primary);
}

.tgi-stat .label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}
```

## Testing Plan

1. **Backend API Testing**
   - Test each endpoint with valid/invalid data
   - Verify authentication works
   - Check error handling

2. **Frontend Testing**
   - Test navigation to TGInvite tab
   - Test channel selection and source management
   - Test file import (JSON, TXT, CSV)
   - Test filter tabs
   - Test import progress

3. **Integration Testing**
   - Test full import workflow
   - Verify stealth settings work
   - Check import history

## Rollback Plan

If issues arise:
1. Remove navigation item from index.html
2. Remove API endpoints from main.py
3. Remove renderTGInvite function from app.js
4. Remove styling from styles.css

## Success Criteria

- [ ] TGInvite tab appears in navigation
- [ ] Can select target channel
- [ ] Can add multiple source channels
- [ ] Can import channels from files
- [ ] Filter tabs work correctly
- [ ] Import progress displays correctly
- [ ] Import history shows past imports
- [ ] All existing functionality remains intact

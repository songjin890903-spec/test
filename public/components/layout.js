/* ============================================================
   共享布局组件 - sidebar + topbar
   ============================================================ */

// 渲染共享布局结构
function renderLayout(containerId, activeNav) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <!-- 侧边栏 -->
    <div class="sidebar">
      <a href="/index.html" class="sidebar-logo" style="text-decoration:none;">
        <img src="/uploads/logo.png" alt="Logo" onerror="this.style.display='none';">
        <div class="sidebar-logo-text">
          <h2>视频提示词</h2>
          <p>生成工具</p>
        </div>
      </a>
      <nav class="sidebar-nav">
        <div class="nav-section-label">功能菜单</div>
        <a href="/index.html" class="nav-item ${activeNav === 'tool' ? 'active' : ''}">✨ 生成提示词</a>
        <a href="/admin.html" class="nav-item ${activeNav === 'account' ? 'active' : ''}">👤 账号管理</a>
      </nav>
    </div>

    <!-- 主内容 -->
    <div class="main">
      <div class="topbar">
        <div class="topbar-user" onclick="toggleDropdown()">
          <div class="user-avatar" id="userAvatar">?</div>
          <span class="user-name" id="userName">加载中...</span>
          <span class="user-role" id="userRole">普通用户</span>
          <span class="dropdown-arrow">▼</span>
        </div>
        <div class="dropdown-menu" id="userDropdown">
          <div class="dropdown-item" onclick="openChangePassword()">🔑 修改密码</div>
          <div class="dropdown-divider"></div>
          <div class="dropdown-item danger" onclick="doLogout()">🚪 退出登录</div>
        </div>
      </div>
      <div class="content" id="mainContent">
        <!-- 页面内容由子类填充 -->
      </div>
    </div>
  `;
}

// 切换下拉菜单
function toggleDropdown() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    dropdown.classList.toggle('show');
  }
}

// 点击其他区域关闭下拉菜单
document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('userDropdown');
  const userEl = document.querySelector('.topbar-user');
  if (dropdown && userEl && !userEl.contains(e.target) && !dropdown.contains(e.target)) {
    dropdown.classList.remove('show');
  }
});

// 加载用户信息
async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/login.html';
      return null;
    }
    const user = await res.json();

    const avatar = document.getElementById('userAvatar');
    const name = document.getElementById('userName');
    const role = document.getElementById('userRole');

    if (avatar) avatar.textContent = user.username ? user.username.charAt(0).toUpperCase() : '?';
    if (name) name.textContent = user.username || '未知用户';
    if (role) {
      if (user.isAdmin) {
        role.textContent = '管理员';
        role.className = 'user-role admin';
      } else {
        role.textContent = '普通用户';
        role.className = 'user-role';
      }
    }

    return user;
  } catch (err) {
    console.error('加载用户信息失败:', err);
    window.location.href = '/login.html';
    return null;
  }
}

// 登出
async function doLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error('登出失败:', err);
  }
  window.location.href = '/login.html';
}

// 修改密码
function openChangePassword() {
  // 子类可覆盖此方法
  alert('请在账号管理页面修改密码');
}
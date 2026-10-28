import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";

onAuthStateChanged(auth, (user) => {
    let rendered = false;

    function renderMenu() {
        const menu = document.getElementById("author-menu-drd");
        if (!menu) return false;

        const bannerBtn = document.querySelector(".banner-text a"); // Nút "Get Started"

        if (user) {
            const userUid = user.uid;
            menu.innerHTML = `
                <li class="px-3 py-2 small fw-bold text-primary border-bottom mb-1">${user.email}</li>
                <li><a class="dropdown-item py-2" href="./projectID.html?uid=${userUid}"><i class="fa-solid fa-folder-open me-2"></i>My Projects</a></li>
                <li><hr class="dropdown-divider"></li>
                <li><button id="logout-btn" class="dropdown-item text-danger py-2"><i class="fa-solid fa-right-from-bracket me-2"></i>Logout</button></li>
            `;
            if (bannerBtn) bannerBtn.href = `./projectID.html?uid=${userUid}`;

            document.getElementById("logout-btn").onclick = async () => {
                await signOut(auth);
                location.reload();
            };
        } else {
            menu.innerHTML = `
                <li><a class="dropdown-item py-2" href="./login.html"><i class="fa-solid fa-sign-in me-2"></i>Sign In</a></li>
                <li><a class="dropdown-item py-2" href="./register.html"><i class="fa-solid fa-user-plus me-2"></i>Sign Up</a></li>
            `;
        }
        return true;
    }

    // Render ngay khi header vừa được inject; fallback poll nếu event bị lỡ.
    if (renderMenu()) { rendered = true; }
    else {
        window.addEventListener("headerLoaded", () => { if (!rendered) rendered = renderMenu() || rendered; }, { once: true });
        const poll = setInterval(() => {
            if (renderMenu()) {
                rendered = true;
                clearInterval(poll);
            }
        }, 100);
        setTimeout(() => clearInterval(poll), 15000); // tránh poll vô hạn
    }
});
import { auth } from "./firebase-config.js";
import { createUserWithEmailAndPassword } from "./firebase-config.js";

document.addEventListener('DOMContentLoaded', function () {

    // --- 1. LẤY DOM ELEMENTS ---
    const registerForm = document.getElementById('register-form');
    const inEmail = document.getElementById('email');
    const inPassword = document.getElementById('password');
    const inConfirmPassword = document.getElementById('confirm-password');
    const togglePasswords = document.querySelectorAll('.toggle-password');

    // --- 2. XỬ LÝ ẨN/HIỆN MẬT KHẨU ---
    togglePasswords.forEach(toggle => {
        toggle.addEventListener('click', function () {
            const input = this.previousElementSibling;
            const icon = this.querySelector('i');
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            icon.classList.toggle('fa-eye', !isPassword);
            icon.classList.toggle('fa-eye-slash', isPassword);
        });
    });

    // --- 3. BIỂU THỨC CHÍNH QUY (REGEX) ---
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

    // --- 4. CÁC HÀM VALIDATE ---
    function validateEmail(isSubmit = false) {
        const val = inEmail.value.trim();
        if (val === '') {
            isSubmit ? inEmail.classList.add('is-invalid') : inEmail.classList.remove('is-invalid');
            return false;
        }
        if (!emailRegex.test(val)) {
            inEmail.classList.add('is-invalid');
            return false;
        }
        inEmail.classList.remove('is-invalid');
        return true;
    }

    function validatePassword(isSubmit = false) {
        if (inPassword.value === '') {
            isSubmit ? inPassword.classList.add('is-invalid') : inPassword.classList.remove('is-invalid');
            return false;
        }
        if (!passwordRegex.test(inPassword.value)) {
            inPassword.classList.add('is-invalid');
            return false;
        }
        inPassword.classList.remove('is-invalid');
        return true;
    }

    function validateConfirmPassword(isSubmit = false) {
        if (inConfirmPassword.value === '') {
            isSubmit ? inConfirmPassword.classList.add('is-invalid') : inConfirmPassword.classList.remove('is-invalid');
            return false;
        }
        if (inPassword.value !== inConfirmPassword.value) {
            inConfirmPassword.classList.add('is-invalid');
            return false;
        }
        inConfirmPassword.classList.remove('is-invalid');
        return true;
    }

    // --- 5. BẮT SỰ KIỆN REAL-TIME ---
    [inEmail, inPassword, inConfirmPassword].forEach(input => {
        input.addEventListener('input', function () {
            if (this.value === '') this.classList.remove('is-invalid');
        });
    });

    inEmail.addEventListener('blur', () => validateEmail(false));
    inPassword.addEventListener('blur', () => {
        validatePassword(false);
        if (inConfirmPassword.value !== '') validateConfirmPassword(false);
    });
    inConfirmPassword.addEventListener('blur', () => validateConfirmPassword(false));

    // --- 6. HÀM XỬ LÝ ĐĂNG KÝ CHÍNH (handleRegister) ---
    const handleRegister = async function (event) {
        event.preventDefault();

        // Ép kiểm tra lỗi toàn bộ
        const isEmailValid = validateEmail(true);
        const isPassValid = validatePassword(true);
        const isConfirmValid = validateConfirmPassword(true);

        if (!isEmailValid || !isPassValid || !isConfirmValid) return;

        const email = inEmail.value;
        const password = inPassword.value;
        const role_id = 2;

        try {
            // The REST backend's /auth/register creates the user record
            // (including role_id) and returns a token + user object.
            await createUserWithEmailAndPassword(auth, email, password);

            alert("Account created successfully.");
            window.location.href = "login.html";

        } catch (error) {
            console.error("System error:", error);
            const msg = error.message || "";
            if (msg.toLowerCase().includes("already")) {
                alert("This email already exists. Please use a different email.");
            } else {
                alert("Error: " + msg);
            }
        }
    };

    // Gắn sự kiện submit cho form
    registerForm.addEventListener('submit', handleRegister);
});
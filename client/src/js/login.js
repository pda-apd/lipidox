import { auth } from "./firebase-config.js";
import { signInWithEmailAndPassword } from "./firebase-config.js";

document.addEventListener('DOMContentLoaded', function() {
    const loginForm = document.getElementById('login-form');
    const inEmail = document.getElementById('email');
    const inPassword = document.getElementById('password');
    
    // Các thẻ chứa nội dung báo lỗi
    const emailError = document.getElementById('email-error');
    const passwordError = document.getElementById('password-error');
    const authError = document.getElementById('login-auth-error');
    
    const togglePasswords = document.querySelectorAll('.toggle-password');

    // 1. ẨN/HIỆN MẬT KHẨU
    togglePasswords.forEach(toggle => {
        toggle.addEventListener('click', function() {
            const input = this.previousElementSibling;
            const icon = this.querySelector('i');
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            icon.classList.toggle('fa-eye', !isPassword);
            icon.classList.toggle('fa-eye-slash', isPassword);
        });
    });

    // 2. HÀM RESET CẢNH BÁO VỀ TRẠNG THÁI BAN ĐẦU
    function resetErrors() {
        inEmail.classList.remove('is-invalid');
        inPassword.classList.remove('is-invalid');
        authError.style.visibility = 'hidden';
        
        // Trả lại nội dung cảnh báo mặc định
        emailError.textContent = "Please enter a valid email address.";
        passwordError.textContent = "Please enter your password.";
    }

    // 3. XÓA LỖI KHI NGƯỜI DÙNG BẮT ĐẦU GÕ LẠI
    [inEmail, inPassword].forEach(input => {
        input.addEventListener('input', resetErrors);
    });

    // 4. XỬ LÝ ĐĂNG NHẬP
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // Validate cơ bản phía Client (trống/định dạng)
        const emailVal = inEmail.value.trim();
        const passVal = inPassword.value.trim();
        let hasError = false;

        if (emailVal === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
            inEmail.classList.add('is-invalid');
            hasError = true;
        }
        if (passVal === '') {
            inPassword.classList.add('is-invalid');
            hasError = true;
        }

        if (hasError) return;

        try {
            const userCredential = await signInWithEmailAndPassword(auth, emailVal, passVal);
            
            // Lưu Session
            const userSession = {
                user: { uid: userCredential.user.uid, email: userCredential.user.email },
                expiry: new Date().getTime() + (1000 * 60 * 60 * 12) 
            };
            localStorage.setItem('userSession', JSON.stringify(userSession));
            
            window.location.href = "index.html";

        } catch (error) {
            console.error("Error:", error.code);
            
            // HIỆN CẢNH BÁO ĐỒNG THỜI KHI SAI TÀI KHOẢN/MẬT KHẨU
            
            // 1. Hiện lỗi tổng quát dưới nút
            authError.style.visibility = 'visible';
            
            // 2. Đổi text và hiện lỗi riêng cho ô Email
            emailError.textContent = "Please check your email.";
            inEmail.classList.add('is-invalid');
            
            // 3. Đổi text và hiện lỗi riêng cho ô Password
            passwordError.textContent = "Please check your password.";
            inPassword.classList.add('is-invalid');
        }
    });
});

import { auth } from "./firebase-config.js";
import { signInWithEmailAndPassword } from "./firebase-config.js";

const inEmail = document.getElementById('email');
const inPassword = document.getElementById('password');
const togglePasswords = document.querySelectorAll('.toggle-password');
const loginForm = document.getElementById('login-form');

const handleLogin = function (e) {
    e.preventDefault();
    let email = inEmail.value;
    let password = inPassword.value;

    if (!email || !password) {
        alert('Please enter both email and password.');
        return;
    }

    signInWithEmailAndPassword(auth, email, password)
        .then((userCredential) => {
            // Đăng nhập thành công
            const user = userCredential.user;
            console.log("Login successful:", user.uid);
                       
            const userSession = {
                user: {
                    uid: user.uid,
                    email: user.email
                },
                expiry: new Date().getTime() + 1000*60*60*12 // 0.5 ngày
            };
            localStorage.setItem('userSession', JSON.stringify(userSession));
            alert("Login successful.");

            window.location.href = "index.html";
        })

        .catch((error) => {
            console.error("Login error:", error);
            alert("Incorrect email or password.");
        });

}      

loginForm.addEventListener('submit', handleLogin);

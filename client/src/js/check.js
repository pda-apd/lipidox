const checksection = function () {
    let userSession = JSON.parse(localStorage.getItem('userSession'));

    if (userSession) {
        const currentTime = new Date().getTime();
        if (currentTime > userSession.expiry) {
            localStorage.removeItem('userSession');
            userSession = null;
            window.location.href = "./login.html";
        } else {
            window.location.href = "./index.html";
        }

    }
}

export { checksection };
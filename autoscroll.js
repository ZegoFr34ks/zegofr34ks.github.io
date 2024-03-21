document.addEventListener("DOMContentLoaded", function() {
    const sections = document.querySelectorAll("section");
    const navLinks = document.querySelectorAll("header ul li a");

    navLinks.forEach((link, index) => {
        link.addEventListener("click", function(event) {
            event.preventDefault();

            const targetSection = sections[index];
            scrollToSection(targetSection);
        });
    });

    function scrollToSection(section) {
        window.scroll({
            behavior: "smooth",
            left: 0,
            top: section.offsetTop
        });
    }
});

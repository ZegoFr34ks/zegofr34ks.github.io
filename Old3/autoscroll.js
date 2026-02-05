document.addEventListener("DOMContentLoaded", function() {
    const sections = document.querySelectorAll("section");

    let scrolling = false;
    let scrollTimeout;

    function centerMostCenteredSection() {
        const viewportCenter = window.innerHeight / 2;
        let closestSection = null;
        let minDistance = Infinity;

        sections.forEach(section => {
            const sectionCenter = section.getBoundingClientRect().top + section.offsetHeight / 2;
            const distance = Math.abs(viewportCenter - sectionCenter);

            if (distance < minDistance) {
                closestSection = section;
                minDistance = distance;
            }
        });

        scrollToSection(closestSection);
    }

    function scrollToSection(section) {
        const targetOffset = section.offsetTop - (window.innerHeight - section.offsetHeight) / 2;
        window.scroll({
            behavior: "smooth",
            top: targetOffset
        });
    }

    window.addEventListener("scroll", function() {
        scrolling = true;
        clearTimeout(scrollTimeout);

        scrollTimeout = setTimeout(function() {
            if (scrolling) {
                scrolling = false;
                centerMostCenteredSection();
            }
        }, 100);
    });
});

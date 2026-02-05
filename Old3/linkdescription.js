document.addEventListener("DOMContentLoaded", function() {
    const links = document.querySelectorAll('.link');
    const descriptionBox = document.querySelector('.description-box');

    links.forEach(link => {
        link.addEventListener('mouseenter', function() {
            const description = this.getAttribute('data-description');
            descriptionBox.textContent = description;
            
            // Check if the screen width is greater than 768px before displaying the description box
            if (window.innerWidth > 768) {
                descriptionBox.style.display = 'block';
            }
        });

        link.addEventListener('mouseleave', function() {
            descriptionBox.style.display = 'none';
        });
    });
});
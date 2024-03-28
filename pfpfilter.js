document.addEventListener("DOMContentLoaded", function() {
    const buttons = document.querySelectorAll('.filter-button');
    const galleries = document.querySelectorAll('.gallery');

    function updateGalleryVisibility() {
        galleries.forEach(gallery => {
            const keywords = gallery.classList;
            let shouldBeActive = true;

            buttons.forEach(button => {
                const buttonFilter = button.getAttribute('data-filter');
                if (keywords.contains(buttonFilter) && button.classList.contains('off')) {
                    shouldBeActive = false;
                }
            });

            if (shouldBeActive) {
                gallery.classList.add('active');
                gallery.classList.remove('inactive');
            } else {
                gallery.classList.remove('active');
                gallery.classList.add('inactive');
            }
        });
    }

    buttons.forEach(button => {
        button.addEventListener('click', function() {
            // Toggle the state of the button
            if (button.classList.contains('on')) {
                button.classList.remove('on');
                button.classList.add('off');
            } else {
                button.classList.remove('off');
                button.classList.add('on');
            }
            updateGalleryVisibility();
        });
    });

    // Initial update
    updateGalleryVisibility();
});
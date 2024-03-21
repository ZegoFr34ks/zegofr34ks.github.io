// Function to generate a random number within a range
function getRandom(min, max) {
    return Math.random() * (max - min) + min;
}

// Function to create stars
function createStars() {
    const middleSection = document.querySelector('.middle-section');
    const numStars = 200; // Adjust the number of stars as needed

    for (let i = 0; i < numStars; i++) {
        const star = document.createElement('div');
        star.classList.add('star');
        star.style.left = `${getRandom(0, 100)}vw`; // Random horizontal position
        star.style.top = `${getRandom(0, 100)}vh`; // Random vertical position
        star.style.animationDelay = `${getRandom(0, 10)}s`; // Random animation delay
        middleSection.appendChild(star);

        // Move stars randomly
        moveStar(star);
    }
}

// Function to move stars randomly
function moveStar(star) {
    const x = getRandom(-10, 10); // Random horizontal movement
    const y = getRandom(-10, 10); // Random vertical movement
    const duration = getRandom(5, 15); // Random duration for each movement

    star.style.transition = `transform ${duration}s linear`;
    star.style.transform = `translate(${x}px, ${y}px)`;

    // Repeat the movement after the duration
    setTimeout(() => moveStar(star), duration * 1000);
}

// Call the function to create stars when the page loads
window.addEventListener('DOMContentLoaded', createStars);
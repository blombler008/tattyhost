from PIL import Image
import numpy as np
import cv2

# Load the image
image_path = "G:/Web/tattyhost/src/assets/logo3.png"
image = Image.open(image_path)
 
# Invert the mask so that red areas become black and the background becomes white
inverted_mask = cv2.bitwise_not(mask_red)

# Find contours again, but now ensuring full shape coverage
contours, _ = cv2.findContours(inverted_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

# Create an improved SVG file
svg_path_improved = "/mnt/data/logo3_improved.svg"
with open(svg_path_improved, "w") as svg_file:
    svg_file.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}">'.format(image.width, image.height))
    
    for contour in contours:
        svg_file.write('<path d="M')
        for point in contour:
            x, y = point[0]
            svg_file.write(f' {x},{y}')
        svg_file.write(' Z" fill="red" stroke="black" stroke-width="1"/>')

    svg_file.write("</svg>")

# Provide the improved SVG file to the user
svg_path_improved

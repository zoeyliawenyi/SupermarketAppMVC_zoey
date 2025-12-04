const Review = require('../models/Review');
const db = require('../db');

const list = (req, res) => {
  const userId = req.session.user.id;
  const selectedProductId = req.query.productId || '';
  Review.listByUser(userId, (err, reviews) => {
    if (err) {
      console.error('DB error /reviews list:', err);
      return res.status(500).send('Database error');
    }
    res.render('reviews', {
      user: req.session.user,
      reviews: reviews || [],
      selectedProductId,
      messages: req.flash('success'),
      errors: req.flash('error')
    });
  });
};

const create = (req, res) => {
  const userId = req.session.user.id;
  const { productId, rating, comment } = req.body;
  const redirectTarget = `/reviews${productId ? `?productId=${productId}` : ''}`;
  if (!productId || !rating) {
    req.flash('error', 'Product and rating are required');
    return res.redirect(redirectTarget);
  }
  const ratingNum = Number(rating);
  if (ratingNum < 1 || ratingNum > 5) {
    req.flash('error', 'Rating must be between 1 and 5');
    return res.redirect(redirectTarget);
  }
  Review.create({ productId, userId, rating: ratingNum, comment: comment || '' }, (err) => {
    if (err) {
      console.error('DB error /reviews create:', err);
      req.flash('error', 'Could not save review');
    } else {
      req.flash('success', 'Review submitted');
    }
    res.redirect(redirectTarget);
  });
};

module.exports = { list, create };

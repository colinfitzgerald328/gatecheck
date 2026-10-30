export class Reviews extends Component {
  state = { sort: 'newest' };
  cache = new Map();

  render() {
    const sorting = this.props.flags.reviewSorting;
    return <ReviewList items={sorting ? sortBy(this.props.reviews, this.state.sort) : this.props.reviews} />;
  }
}
